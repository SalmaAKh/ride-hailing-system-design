import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, redis, REDIS_KEYS, driverLockKey, type Ride, type Driver } from '@uber-clone/shared';

const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL ?? 'http://localhost:3003';
const SEARCH_RADIUS_KM = 5;
const LOCK_TTL_SECONDS = 10; // matches how long a driver will be given to accept, once that exists

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

async function isDriverAvailable(driverId: string): Promise<boolean> {
  const result = await ddb.send(new GetCommand({ TableName: TABLES.DRIVERS, Key: { id: driverId } }));
  const driver = result.Item as Driver | undefined;
  return driver?.status === 'available';
}

async function tryLockDriver(driverId: string, rideId: string): Promise<boolean> {
  // SET key value NX EX ttl - an atomic "set only if not already set" with
  // auto-expiry, done as one indivisible Redis operation. That's what
  // guarantees two concurrent matching attempts can never both succeed in
  // locking the same driver - a separate "check, then set" would race.
  const result = await redis.set(driverLockKey(driverId), rideId, 'EX', LOCK_TTL_SECONDS, 'NX');
  return result === 'OK';
}

async function processRideRequest(rideId: string): Promise<void> {
  const result = await ddb.send(new GetCommand({ TableName: TABLES.RIDES, Key: { id: rideId } }));
  const ride = result.Item as Ride | undefined;
  if (!ride) {
    console.error(`ride ${rideId} not found, skipping`);
    return;
  }

  const driverIds = await findNearbyDriverIds(ride.source.lat, ride.source.long);
  console.log(`ride ${rideId}: found ${driverIds.length} nearby driver(s)`);

  for (const driverId of driverIds) {
    if (!(await isDriverAvailable(driverId))) {
      continue;
    }

    if (!(await tryLockDriver(driverId, rideId))) {
      continue; // another in-flight match already holds this driver's lock
    }

    // First slice stops here - no notification/accept flow yet, this just
    // proves the queue -> search -> availability -> lock chain works.
    console.log(`ride ${rideId}: locked driver ${driverId}, would notify now`);
    return;
  }

  console.log(`ride ${rideId}: no available driver found nearby`);
}

async function main() {
  console.log('matching-service worker started, waiting for ride requests...');

  // BRPOP blocks until an item is available instead of polling - the
  // process just sleeps (no CPU spent) until ride-service pushes something.
  for (;;) {
    const popped = await redis.brpop(REDIS_KEYS.RIDE_REQUEST_QUEUE, 0);
    if (!popped) continue;

    const [, rideId] = popped;
    try {
      await processRideRequest(rideId);
    } catch (err) {
      console.error(`error processing ride ${rideId}:`, err);
    }
  }
}

main();
