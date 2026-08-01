import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  ddb,
  TABLES,
  redis,
  REDIS_KEYS,
  driverLockKey,
  rideResponseKey,
  verifyToken,
  type AuthTokenPayload,
  type Ride,
  type UserRole,
} from '@uber-clone/shared';
import { estimateFare } from './fare';

const app = Fastify({ logger: true });

// Shared by every endpoint below that needs a verified rider or driver -
// pulls identity from the token instead of trusting anything client-supplied.
async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  role: UserRole,
): Promise<AuthTokenPayload | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    await reply.status(401).send({ error: 'missing or malformed Authorization header' });
    return null;
  }

  let payload: AuthTokenPayload;
  try {
    payload = verifyToken(authHeader.slice('Bearer '.length));
  } catch {
    await reply.status(401).send({ error: 'invalid or expired token' });
    return null;
  }

  if (payload.role !== role) {
    await reply.status(403).send({ error: `only ${role}s can perform this action` });
    return null;
  }

  return payload;
}

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
    const payload = await requireAuth(request, reply, 'rider');
    if (!payload) return;

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

app.patch<{ Body: { rideId: string; accept: boolean } }>(
  '/ride/driver/accept',
  {
    schema: {
      body: {
        type: 'object',
        required: ['rideId', 'accept'],
        properties: {
          rideId: { type: 'string' },
          accept: { type: 'boolean' },
        },
      },
    },
  },
  async (request, reply) => {
    const payload = await requireAuth(request, reply, 'driver');
    if (!payload) return;

    const { rideId, accept } = request.body;
    const driverId = payload.profileId;

    // Confirm this driver actually holds the current lock for this ride -
    // otherwise a stale token, or a lock that's already moved on to
    // another driver, could let someone accept a ride they were never
    // offered.
    const lockedRideId = await redis.get(driverLockKey(driverId));
    if (lockedRideId !== rideId) {
      return reply.status(409).send({ error: 'no active offer for this ride and driver' });
    }

    if (!accept) {
      // Release early instead of waiting out the TTL, so matching-service
      // can retry the next candidate immediately instead of idling out
      // the remaining lock duration.
      await redis.del(driverLockKey(driverId));
      await redis.lpush(rideResponseKey(rideId), 'declined');
      return reply.send({ declined: true });
    }

    const now = new Date().toISOString();

    // ReturnValues: 'ALL_NEW' hands back the updated item in the same
    // round trip, so we don't need a separate GetCommand just to read
    // source (the pickup point) back out.
    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLES.RIDES,
        Key: { id: rideId },
        UpdateExpression: 'SET #status = :status, driverId = :driverId, matchedAt = :matchedAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'matched', ':driverId': driverId, ':matchedAt': now },
        ReturnValues: 'ALL_NEW',
      }),
    );

    await ddb.send(
      new UpdateCommand({
        TableName: TABLES.DRIVERS,
        Key: { id: driverId },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'in_ride' },
      }),
    );

    // Wakes up matching-service's BLPOP, which is waiting on exactly this
    // key for exactly this ride.
    await redis.lpush(rideResponseKey(rideId), 'accepted');

    const ride = result.Attributes as Ride;
    return reply.send({ pickup: ride.source });
  },
);

const RIDE_UPDATE_TIMESTAMP_FIELDS = {
  picked_up: 'pickedUpAt',
  dropped_off: 'droppedOffAt',
  completed: 'completedAt',
} as const;

app.patch<{ Body: { rideId: string; status: 'picked_up' | 'dropped_off' | 'completed' } }>(
  '/ride/driver/update',
  {
    schema: {
      body: {
        type: 'object',
        required: ['rideId', 'status'],
        properties: {
          rideId: { type: 'string' },
          status: { type: 'string', enum: ['picked_up', 'dropped_off', 'completed'] },
        },
      },
    },
  },
  async (request, reply) => {
    const payload = await requireAuth(request, reply, 'driver');
    if (!payload) return;

    const { rideId, status } = request.body;
    const driverId = payload.profileId;

    const rideResult = await ddb.send(new GetCommand({ TableName: TABLES.RIDES, Key: { id: rideId } }));
    const ride = rideResult.Item as Ride | undefined;

    if (!ride || ride.driverId !== driverId) {
      return reply.status(403).send({ error: 'this ride is not assigned to you' });
    }

    const now = new Date().toISOString();
    const timestampField = RIDE_UPDATE_TIMESTAMP_FIELDS[status];

    await ddb.send(
      new UpdateCommand({
        TableName: TABLES.RIDES,
        Key: { id: rideId },
        UpdateExpression: `SET #status = :status, ${timestampField} = :timestamp`,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status, ':timestamp': now },
      }),
    );

    if (status === 'dropped_off') {
      // Ride's over - free the driver up to be matched again.
      await ddb.send(
        new UpdateCommand({
          TableName: TABLES.DRIVERS,
          Key: { id: driverId },
          UpdateExpression: 'SET #status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': 'available' },
        }),
      );
    }

    return reply.send({ rideId, status });
  },
);

const port = Number(process.env.PORT ?? 3001);

app.listen({ port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
