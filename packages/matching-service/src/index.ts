import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  ddb,
  TABLES,
  redis,
  REDIS_KEYS,
  driverLockKey,
  driverHeartbeatKey,
  driverCellKey,
  rideResponseKey,
  type Ride,
  type Driver,
} from '@uber-clone/shared';

// BRPOP/BLPOP block the connection they're issued on until they resolve.
// The shared `redis` client is used everywhere else for fast, non-blocking
// commands (GET/SET/ZREM) - if a blocking call shared that connection, it
// would stall every other command using it for as long as it's waiting.
// Blocking calls each get their own dedicated connection instead: one for
// the main queue loop (blocks forever), and one per ride being matched
// concurrently (each waits on a different ride-response key).
const queueConnection = redis.duplicate();

const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL ?? 'http://localhost:3003';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL ?? 'http://localhost:3004';
const SEARCH_RADIUS_KM = 5;
const LOCK_TTL_SECONDS = 10; // how long a locked driver has to accept/decline
const MATCH_TIMEOUT_MS = 60_000; // non-functional requirement: match or fail within a minute

async function findNearbyDriverIds(lat: number, long: number): Promise<string[]> {
  const url = new URL('/location/nearby-drivers', LOCATION_SERVICE_URL);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('long', String(long));
  url.searchParams.set('radiusKm', String(SEARCH_RADIUS_KM));

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`location-service returned ${res.status}`);
  }
  const body = (await res.json()) as { driverIds: string[] };
  return body.driverIds;
}

async function notifyDriver(driverId: string, rideId: string): Promise<void> {
  const res = await fetch(`${NOTIFICATION_SERVICE_URL}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driverId, rideId }),
  });
  if (!res.ok) {
    console.error(`notification-service returned ${res.status} for driver ${driverId}`);
  }
}

// A candidate only counts as live if DynamoDB says available AND they've
// sent a location update recently - either signal failing means drop them
// from the GEO set right here. Lazy cleanup: no separate sweep job, just
// whoever encounters a stale driver during real matching work cleans it up.
async function checkDriverAndCleanupIfStale(driverId: string): Promise<boolean> {
  const [driverResult, heartbeat] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLES.DRIVERS, Key: { id: driverId } })),
    redis.exists(driverHeartbeatKey(driverId)),
  ]);

  const driver = driverResult.Item as Driver | undefined;
  const isLive = driver?.status === 'available' && heartbeat === 1;

  if (!isLive) {
    // Locations are geo-sharded into per-cell keys, so removing a stale
    // driver means looking up which cell they're currently in first -
    // there's no single global key to ZREM from anymore.
    const cellKey = await redis.get(driverCellKey(driverId));
    if (cellKey) {
      await redis.zrem(cellKey, driverId);
      await redis.del(driverCellKey(driverId));
    }
  }

  return isLive;
}

async function tryLockDriver(driverId: string, rideId: string): Promise<boolean> {
  // SET key value NX EX ttl - an atomic "set only if not already set" with
  // auto-expiry, done as one indivisible Redis operation. That's what
  // guarantees two concurrent matching attempts can never both succeed in
  // locking the same driver - a separate "check, then set" would race.
  const result = await redis.set(driverLockKey(driverId), rideId, 'EX', LOCK_TTL_SECONDS, 'NX');
  return result === 'OK';
}

async function markUnmatched(rideId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLES.RIDES,
      Key: { id: rideId },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': 'unmatched' },
    }),
  );
}

async function processRideRequest(rideId: string): Promise<void> {
  const startedAt = Date.now();

  const result = await ddb.send(new GetCommand({ TableName: TABLES.RIDES, Key: { id: rideId } }));
  const ride = result.Item as Ride | undefined;
  if (!ride) {
    console.error(`ride ${rideId} not found, skipping`);
    return;
  }

  const driverIds = await findNearbyDriverIds(ride.source.lat, ride.source.long);
  console.log(`ride ${rideId}: found ${driverIds.length} nearby driver(s)`);

  for (const driverId of driverIds) {
    if (Date.now() - startedAt > MATCH_TIMEOUT_MS) {
      console.log(`ride ${rideId}: time budget exceeded, giving up`);
      await markUnmatched(rideId);
      return;
    }

    if (!(await checkDriverAndCleanupIfStale(driverId))) {
      continue;
    }

    if (!(await tryLockDriver(driverId, rideId))) {
      continue; // another in-flight match already holds this driver's lock
    }

    console.log(`ride ${rideId}: locked driver ${driverId}, notifying`);
    await notifyDriver(driverId, rideId);

    // Own connection for this wait - another ride being matched at the
    // same time is doing its own BLPOP concurrently, on its own key, and
    // the two must not be able to block each other.
    const responseConnection = redis.duplicate();
    let response: [string, string] | null;
    try {
      // Blocks until ride-service LPUSHes a response for this specific
      // ride, or times out after LOCK_TTL_SECONDS - the same window as
      // the lock, so there's no gap where the lock outlives our
      // willingness to wait.
      response = await responseConnection.blpop(rideResponseKey(rideId), LOCK_TTL_SECONDS);
    } finally {
      responseConnection.disconnect();
    }

    if (response?.[1] === 'accepted') {
      console.log(`ride ${rideId}: driver ${driverId} accepted`);
      return;
    }

    console.log(`ride ${rideId}: driver ${driverId} declined or timed out, trying next candidate`);
    // If this was a timeout rather than an explicit decline, the lock is
    // left to expire on its own - safer than deleting it here in case the
    // driver's response is still in flight.
  }

  console.log(`ride ${rideId}: no available driver matched in time`);
  await markUnmatched(rideId);
}

async function main() {
  console.log('matching-service worker started, waiting for ride requests...');

  // BRPOP blocks until an item is available instead of polling - the
  // process just sleeps (no CPU spent) until ride-service pushes something.
  for (;;) {
    const popped = await queueConnection.brpop(REDIS_KEYS.RIDE_REQUEST_QUEUE, 0);
    if (!popped) continue;

    const [, rideId] = popped;
    // Not awaited - lets multiple rides be matched concurrently instead of
    // one worker serializing behind however long each match takes (up to
    // MATCH_TIMEOUT_MS). Errors are caught here since nothing else awaits
    // this promise.
    processRideRequest(rideId).catch((err) => {
      console.error(`error processing ride ${rideId}:`, err);
    });
  }
}

main();
