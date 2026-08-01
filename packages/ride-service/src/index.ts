import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, redis, REDIS_KEYS, verifyToken, type Ride } from '@uber-clone/shared';
import { estimateFare } from './fare';

const app = Fastify({ logger: true });

// Two fare values only count as "the same" within a cent - avoids false
// positives from floating-point rounding when the same distance is
// recomputed a second time.
const FARE_CHANGE_TOLERANCE = 0.01;

const coordinatesSchema = {
  type: 'object',
  required: ['lat', 'long'],
  properties: {
    lat: { type: 'number' },
    long: { type: 'number' },
  },
};

// Fastify validates the body against this JSON schema before the handler
// runs, so a malformed request (missing field, wrong type) gets rejected
// with a 400 automatically - no hand-written validation needed.
app.post<{ Body: { source: Ride['source']; destination: Ride['destination'] } }>(
  '/ride/fare-estimate',
  {
    schema: {
      body: {
        type: 'object',
        required: ['source', 'destination'],
        properties: {
          source: coordinatesSchema,
          destination: coordinatesSchema,
        },
      },
    },
  },
  async (request): Promise<Partial<Ride>> => {
    const { source, destination } = request.body;
    const fare = estimateFare(source, destination);
    return { source, destination, fare };
  },
);

app.patch<{
  Body: { source: Ride['source']; destination: Ride['destination']; fare: number };
}>(
  '/ride/request',
  {
    schema: {
      body: {
        type: 'object',
        required: ['source', 'destination', 'fare'],
        properties: {
          source: coordinatesSchema,
          destination: coordinatesSchema,
          fare: { type: 'number' },
        },
      },
    },
  },
  async (request, reply) => {
    // riderId comes from a verified token, never from the request body -
    // otherwise any client could request a ride "as" any rider just by
    // naming their id. auth-service issues this token at login.
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

    if (payload.role !== 'rider') {
      return reply.status(403).send({ error: 'only riders can request rides' });
    }

    const { source, destination, fare: quotedFare } = request.body;

    // The quoted fare came from an earlier /ride/fare-estimate call with no
    // link back to this request, so it's never trusted as-is - recompute
    // from source/destination and treat that as the real fare.
    const fare = estimateFare(source, destination);
    const fareChanged = Math.abs(fare - quotedFare) > FARE_CHANGE_TOLERANCE;

    const now = new Date().toISOString();
    const ride: Ride = {
      id: randomUUID(),
      riderId: payload.profileId,
      source,
      destination,
      fare,
      status: 'requested',
      requestedAt: now,
      createdAt: now,
    };

    await ddb.send(new PutCommand({ TableName: TABLES.RIDES, Item: ride }));

    // Hand off to matching-service via the Ride Request Queue instead of
    // calling it directly - decouples ride creation from the matching
    // loop, which can take several seconds per candidate driver.
    await redis.lpush(REDIS_KEYS.RIDE_REQUEST_QUEUE, ride.id);

    return { ...ride, fareChanged };
  },
);

const port = Number(process.env.PORT ?? 3001);

app.listen({ port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
