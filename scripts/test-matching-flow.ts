/**
 * Runs the full ride lifecycle end to end against the running services -
 * login driver, refresh their location, login rider, request a ride,
 * accept it, mark picked up / dropped off - with no manual copy-paste
 * between steps. The driver-heartbeat and driver-lock TTLs (30s/10s) make
 * this flow easy to accidentally race by hand; this script doesn't.
 *
 * Requires: docker compose up -d, all five services running
 * (auth/ride/location/matching/notification-service), and the seed script
 * already run once (uses the seeded rider + driver credentials).
 *
 * Run with: npm run test-matching-flow
 */
const AUTH_URL = 'http://localhost:3002';
const RIDE_URL = 'http://localhost:3001';
const LOCATION_URL = 'http://localhost:3003';

const SEED_PASSWORD = 'seed-password-123'; // matches scripts/seed.ts
const DRIVER_EMAIL = 'jordan.reyes@example.com';
const RIDER_EMAIL = 'salmamcu@gmail.com';

const DRIVER_LOCATION = { lat: 40.7128, long: -74.006 };
const RIDE_SOURCE = { lat: 40.713, long: -74.0055 }; // ~100m from the driver
const RIDE_DESTINATION = { lat: 40.7484, long: -73.9857 };

async function postJson(url: string, body: unknown, token?: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(`POST ${url} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function patchJson(url: string, body: unknown, token?: string) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(`PATCH ${url} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  console.log('logging in as driver...');
  const driverLogin = await postJson(`${AUTH_URL}/auth/login`, {
    email: DRIVER_EMAIL,
    password: SEED_PASSWORD,
  });
  const driverToken = driverLogin.token as string;
  console.log(`✅ driver token acquired (profileId: ${driverLogin.profileId})`);

  console.log('refreshing driver location + heartbeat...');
  await postJson(`${LOCATION_URL}/location/update`, DRIVER_LOCATION, driverToken);
  console.log('✅ driver location updated');

  console.log('logging in as rider...');
  const riderLogin = await postJson(`${AUTH_URL}/auth/login`, {
    email: RIDER_EMAIL,
    password: SEED_PASSWORD,
  });
  const riderToken = riderLogin.token as string;
  console.log(`✅ rider token acquired (profileId: ${riderLogin.profileId})`);

  console.log('requesting a ride...');
  const ride = await patchJson(
    `${RIDE_URL}/ride/request`,
    { source: RIDE_SOURCE, destination: RIDE_DESTINATION, fare: 10 },
    riderToken,
  );
  console.log(`✅ ride requested: ${ride.id} (fare: ${ride.fare})`);

  console.log('waiting 2s for matching-service to lock the driver...');
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log('accepting the ride as the driver...');
  const accept = await patchJson(
    `${RIDE_URL}/ride/driver/accept`,
    { rideId: ride.id, accept: true },
    driverToken,
  );
  console.log(`✅ accepted, pickup point: ${JSON.stringify(accept.pickup)}`);

  console.log('marking picked up...');
  await patchJson(`${RIDE_URL}/ride/driver/update`, { rideId: ride.id, status: 'picked_up' }, driverToken);
  console.log('✅ picked up');

  console.log('marking dropped off...');
  await patchJson(`${RIDE_URL}/ride/driver/update`, { rideId: ride.id, status: 'dropped_off' }, driverToken);
  console.log('✅ dropped off');

  console.log('marking completed...');
  await patchJson(`${RIDE_URL}/ride/driver/update`, { rideId: ride.id, status: 'completed' }, driverToken);
  console.log('✅ completed');

  console.log(`\n🎉 full ride lifecycle completed for ride ${ride.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
