import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, type Ride } from '@uber-clone/shared';
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

// riderId is passed directly in the body as a stand-in for real auth,
// which doesn't exist yet - see CLAUDE.md. Revisit once there's a login
// flow to pull this from a session instead.
app.patch<{
  Body: { riderId: string; source: Ride['source']; destination: Ride['destination']; fare: number };
}>(
  '/ride/request',
  {
    schema: {
      body: {
        type: 'object',
        required: ['riderId', 'source', 'destination', 'fare'],
        properties: {
          riderId: { type: 'string' },
          source: coordinatesSchema,
          destination: coordinatesSchema,
          fare: { type: 'number' },
        },
      },
    },
  },
  async (request): Promise<Ride & { fareChanged: boolean }> => {
    const { riderId, source, destination, fare: quotedFare } = request.body;

    // The quoted fare came from an earlier /ride/fare-estimate call with no
    // link back to this request, so it's never trusted as-is - recompute
    // from source/destination and treat that as the real fare.
    const fare = estimateFare(source, destination);
    const fareChanged = Math.abs(fare - quotedFare) > FARE_CHANGE_TOLERANCE;

    const now = new Date().toISOString();
    const ride: Ride = {
      id: randomUUID(),
      riderId,
      source,
      destination,
      fare,
      status: 'requested',
      requestedAt: now,
      createdAt: now,
    };

    await ddb.send(new PutCommand({ TableName: TABLES.RIDES, Item: ride }));

    return { ...ride, fareChanged };
  },
);

const port = Number(process.env.PORT ?? 3001);

app.listen({ port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
