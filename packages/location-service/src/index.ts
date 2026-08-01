import Fastify from 'fastify';
import { redis, driverHeartbeatKey, geoCell, driverLocationsKey, driverCellKey, verifyToken } from '@uber-clone/shared';

const app = Fastify({ logger: true });

// Riders/drivers poll every ~5s per the non-functional requirements, so a
// driver silent for 30s (~6 missed cycles) is a reasonable "probably gone"
// threshold - generous enough to tolerate one or two dropped requests.
const HEARTBEAT_TTL_SECONDS = 30;

app.post<{ Body: { lat: number; long: number } }>(
  '/location/update',
  {
    schema: {
      body: {
        type: 'object',
        required: ['lat', 'long'],
        properties: {
          lat: { type: 'number' },
          long: { type: 'number' },
        },
      },
    },
  },
  async (request, reply) => {
    // Same principle as ride-service's /ride/request: driverId comes from
    // a verified token, never the body - otherwise any client could
    // overwrite any driver's location just by naming their id.
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'missing or malformed Authorization header' });
    }

    let payload;
    try {
      payload = verifyToken(authHeader.slice('Bearer '.length));
    } catch {
      return reply.status(401).send({ error: 'invalid or expired token' });
    }

    if (payload.role !== 'driver') {
      return reply.status(403).send({ error: 'only drivers can update location' });
    }

    const { lat, long } = request.body;
    const driverId = payload.profileId;

    // GEOADD stores each member in a sorted set, but scored by a geohash -
    // lat/long interleaved into a single 52-bit number - instead of a plain
    // value. That's what lets GEOSEARCH later ask "who's within N km of
    // this point" as a range scan over that score, rather than computing
    // distance against every driver one by one. Locations are geo-sharded
    // into one GEO key per grid cell (see CLAUDE.md) rather than one
    // global key, so no single Redis key has to absorb every driver's
    // updates.
    const { latCell, longCell } = geoCell(lat, long);
    const newCellKey = driverLocationsKey(latCell, longCell);

    // If the driver moved into a different cell since their last update,
    // remove them from the old one first - otherwise they'd persist as a
    // stale candidate there. The heartbeat/status staleness check alone
    // wouldn't catch this, since both stay fresh regardless of which cell
    // gets written to.
    const previousCellKey = await redis.get(driverCellKey(driverId));
    if (previousCellKey && previousCellKey !== newCellKey) {
      await redis.zrem(previousCellKey, driverId);
    }

    await redis.geoadd(newCellKey, long, lat, driverId);
    await redis.set(driverCellKey(driverId), newCellKey);

    // Separate from GEOADD because GEO sets can't expire individual
    // members - this plain key with a TTL is what lets matching-service
    // later tell "this driver is still live" apart from "DynamoDB still
    // says available, but nobody's heard from them in a while".
    await redis.set(driverHeartbeatKey(driverId), '1', 'EX', HEARTBEAT_TTL_SECONDS);

    return reply.send({ driverId, lat, long });
  },
);

const DEFAULT_RADIUS_KM = 5;

// No auth here, unlike /location/update - this is a read-only query with
// no effect on any specific rider/driver's data, called internally by
// matching-service rather than a client acting as a particular user.
app.get<{ Querystring: { lat: number; long: number; radiusKm?: number } }>(
  '/location/nearby-drivers',
  {
    schema: {
      querystring: {
        type: 'object',
        required: ['lat', 'long'],
        properties: {
          lat: { type: 'number' },
          long: { type: 'number' },
          radiusKm: { type: 'number' },
        },
      },
    },
  },
  async (request) => {
    const { lat, long, radiusKm = DEFAULT_RADIUS_KM } = request.query;

    // A driver just across a cell boundary from the search point would be
    // missed if we only queried the search point's own cell, even if
    // they're well within radiusKm - so query that cell plus its 8
    // neighbors. Cell size (~11km) is deliberately bigger than
    // radiusKm (5km default) so this 3x3 neighborhood is always enough.
    const { latCell, longCell } = geoCell(lat, long);
    const neighborKeys: string[] = [];
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLong = -1; dLong <= 1; dLong++) {
        neighborKeys.push(driverLocationsKey(latCell + dLat, longCell + dLong));
      }
    }

    // GEOSEARCH turns "who's within N km of this point" into a range scan
    // over the geohash score GEOADD stored, instead of computing distance
    // against every driver one by one. WITHDIST returns each match's
    // distance so results from the 9 separate keys can be merged and
    // re-sorted afterward - ASC only guarantees nearest-first within a
    // single key's own results, not across results merged from several.
    const resultsPerCell = await Promise.all(
      neighborKeys.map(
        (key) =>
          redis.geosearch(
            key,
            'FROMLONLAT',
            long,
            lat,
            'BYRADIUS',
            radiusKm,
            'km',
            'ASC',
            'WITHDIST',
          ) as Promise<[string, string][]>,
      ),
    );

    const merged = resultsPerCell.flat();
    merged.sort((a, b) => Number(a[1]) - Number(b[1]));

    return { driverIds: merged.map(([driverId]) => driverId) };
  },
);

const port = Number(process.env.PORT ?? 3003);

app.listen({ port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
