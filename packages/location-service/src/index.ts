import Fastify from 'fastify';
import { redis, REDIS_KEYS, verifyToken } from '@uber-clone/shared';

const app = Fastify({ logger: true });

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
    // distance against every driver one by one. One key holds every
    // driver's location so a single GEOSEARCH can scan across all of them.
    await redis.geoadd(REDIS_KEYS.DRIVER_LOCATIONS, long, lat, driverId);

    return reply.send({ driverId, lat, long });
  },
);

const port = Number(process.env.PORT ?? 3003);

app.listen({ port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
