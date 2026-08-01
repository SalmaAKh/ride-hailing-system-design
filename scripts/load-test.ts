/**
 * Fires many concurrent ride requests against the running services and
 * checks the one thing that actually matters: did the driver-lock
 * mechanism hold up under real concurrency, i.e. did every matched ride
 * get a *distinct* driver, with none double-booked.
 *
 * Each seeded driver runs a small "auto-accept" worker that polls its own
 * driver-lock key and accepts as soon as it's offered a ride - without
 * this, no ride would ever reach 'matched' (every offer would just time
 * out after 10s with nobody responding), which would make the double-
 * booking check vacuously true instead of actually proving anything.
 *
 * Requires: all five services running, and scripts/seed-load-test.ts
 * already run with driver/rider counts >= what's passed here.
 *
 * Run with: npm run load-test -- --drivers=10 --riders=20 --waitSeconds=20
 */
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, redis, driverLockKey, type Ride } from '@uber-clone/shared';
import { LOAD_TEST_PASSWORD } from './load-test-config';

const AUTH_URL = 'http://localhost:3002';
const RIDE_URL = 'http://localhost:3001';
const LOCATION_URL = 'http://localhost:3003';

const CENTER = { lat: 40.7128, long: -74.006 };
const JITTER_KM = 2; // keeps everyone within matching-service's 5km search radius
const ACCEPT_POLL_MS = 150;

function parseArg(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? Number(arg.split('=')[1]) : fallback;
}

function jitteredCoordinate(center: { lat: number; long: number }, maxKm: number) {
  // Rough conversion, fine at this scale: 1 degree latitude ~= 111km,
  // longitude shrinks by cos(latitude).
  const kmToLatDegrees = maxKm / 111;
  const kmToLongDegrees = maxKm / (111 * Math.cos((center.lat * Math.PI) / 180));
  return {
    lat: center.lat + (Math.random() * 2 - 1) * kmToLatDegrees,
    long: center.long + (Math.random() * 2 - 1) * kmToLongDegrees,
  };
}

async function postJson(url: string, body: unknown, token?: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function patchJson(url: string, body: unknown, token?: string) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`PATCH ${url} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

interface DriverSession {
  token: string;
  profileId: string;
}

async function loginAndPlaceDriver(index: number): Promise<DriverSession> {
  const email = `load-test-driver-${index}@example.com`;
  const { token, profileId } = await postJson(`${AUTH_URL}/auth/login`, { email, password: LOAD_TEST_PASSWORD });
  await postJson(`${LOCATION_URL}/location/update`, jitteredCoordinate(CENTER, JITTER_KM), token);
  return { token, profileId };
}

async function loginRider(index: number): Promise<string> {
  const email = `load-test-rider-${index}@example.com`;
  const { token } = await postJson(`${AUTH_URL}/auth/login`, { email, password: LOAD_TEST_PASSWORD });
  return token;
}

async function requestRide(riderToken: string): Promise<string> {
  const source = jitteredCoordinate(CENTER, JITTER_KM);
  const destination = jitteredCoordinate(CENTER, JITTER_KM + 5);
  const ride = await patchJson(`${RIDE_URL}/ride/request`, { source, destination, fare: 10 }, riderToken);
  return ride.id as string;
}

// Polls this driver's own lock key, accepts the first offer it sees, then
// immediately drives the ride through the rest of its lifecycle - without
// this, no ride would ever reach 'matched' (every offer would just time
// out after 10s with nobody responding), let alone 'completed'. Stops
// after one ride (a real driver only holds one at a time) or once the
// deadline passes with no offer.
async function driverAutoAccept(session: DriverSession, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const rideId = await redis.get(driverLockKey(session.profileId));
    if (rideId) {
      try {
        await patchJson(`${RIDE_URL}/ride/driver/accept`, { rideId, accept: true }, session.token);
        await patchJson(`${RIDE_URL}/ride/driver/update`, { rideId, status: 'picked_up' }, session.token);
        await patchJson(`${RIDE_URL}/ride/driver/update`, { rideId, status: 'dropped_off' }, session.token);
        await patchJson(`${RIDE_URL}/ride/driver/update`, { rideId, status: 'completed' }, session.token);
      } catch {
        // Lock may have already expired or been claimed by the time we
        // tried to accept - fine, this driver just missed this offer.
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ACCEPT_POLL_MS));
  }
}

async function main() {
  const driverCount = parseArg('drivers', 10);
  const riderCount = parseArg('riders', 20);
  const waitSeconds = parseArg('waitSeconds', 20);

  console.log(`logging in ${driverCount} drivers and setting their locations...`);
  let start = Date.now();
  const driverSessions = await Promise.all(Array.from({ length: driverCount }, (_, i) => loginAndPlaceDriver(i)));
  console.log(`✅ drivers ready in ${Date.now() - start}ms`);

  console.log(`logging in ${riderCount} riders...`);
  start = Date.now();
  const riderTokens = await Promise.all(Array.from({ length: riderCount }, (_, i) => loginRider(i)));
  console.log(`✅ riders logged in in ${Date.now() - start}ms`);

  console.log('starting driver auto-accept workers...');
  const acceptDeadlineMs = waitSeconds * 1000;
  const acceptWorkers = Promise.all(driverSessions.map((session) => driverAutoAccept(session, acceptDeadlineMs)));

  console.log(`firing ${riderCount} ride requests at once...`);
  start = Date.now();
  const results = await Promise.allSettled(riderTokens.map((token) => requestRide(token)));
  console.log(`✅ all ride requests submitted in ${Date.now() - start}ms`);

  const rideIds = results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
    .map((r) => r.value);
  const failedCount = results.length - rideIds.length;
  console.log(`${rideIds.length} requests accepted, ${failedCount} failed outright`);

  console.log(`waiting up to ${waitSeconds}s for drivers to accept and matching to settle...`);
  await acceptWorkers;

  console.log('checking outcomes...');
  const rides = await Promise.all(
    rideIds.map(async (id) => {
      const result = await ddb.send(new GetCommand({ TableName: TABLES.RIDES, Key: { id } }));
      return result.Item as Ride | undefined;
    }),
  );

  const byStatus: Record<string, number> = {};
  const driverIdToRideIds = new Map<string, string[]>();

  for (const ride of rides) {
    if (!ride) continue;
    byStatus[ride.status] = (byStatus[ride.status] ?? 0) + 1;
    // driverId only ever gets set once, at accept time - checking every
    // status that implies an assignment happened (not just 'matched')
    // matters here, since auto-accept workers race straight through to
    // 'completed', so by the time we check, few if any rides are still
    // sitting at 'matched'.
    if (ride.driverId) {
      const existing = driverIdToRideIds.get(ride.driverId) ?? [];
      existing.push(ride.id);
      driverIdToRideIds.set(ride.driverId, existing);
    }
  }

  console.log('\n--- results ---');
  console.log('status breakdown:', byStatus);

  const doubleBooked = [...driverIdToRideIds.entries()].filter(([, rideIdsForDriver]) => rideIdsForDriver.length > 1);
  if (doubleBooked.length > 0) {
    console.error('❌ BUG: driver(s) assigned to more than one ride at once:');
    for (const [driverId, rideIdsForDriver] of doubleBooked) {
      console.error(`   driver ${driverId}: rides ${rideIdsForDriver.join(', ')}`);
    }
  } else {
    console.log(`✅ every assigned ride got a distinct driver - no double-booking across ${driverIdToRideIds.size} assigned driver(s)`);
  }

  if (byStatus.completed) {
    console.log(`✅ ${byStatus.completed} ride(s) completed the full lifecycle end to end`);
  }

  if (byStatus.requested) {
    console.log(`ℹ️  ${byStatus.requested} ride(s) still 'requested' - still mid-match, try a longer --waitSeconds`);
  }

  // @uber-clone/shared's barrel export opens a Redis connection as an
  // import side effect (redis-client.ts) - keeps the event loop alive
  // forever otherwise.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
