/**
 * Micro-benchmark for POST /location/update alone - not the full ride
 * cycle. Measures raw throughput this machine's single location-service
 * + Redis instance can sustain, as the empirical basis for a back-of-
 * envelope capacity calculation against the "600k TPS on driver location
 * updates, from 3M active drivers polling every 5s" non-functional
 * requirement in CLAUDE.md.
 *
 * Logs in a pool of drivers once - login is deliberately excluded from
 * the measured window, since it's dominated by scrypt cost, not anything
 * location-update-specific - then fires increasing bursts of concurrent
 * /location/update calls reusing those tokens, measuring completed
 * requests / elapsed time at each burst size to find where it plateaus.
 *
 * Requires: location-service and auth-service running, and
 * scripts/seed-load-test.ts already run with driver count >= DRIVER_POOL_SIZE.
 *
 * Run with: npm run location-update-benchmark
 */
import { LOAD_TEST_PASSWORD } from './load-test-config';

const AUTH_URL = 'http://localhost:3002';
const LOCATION_URL = 'http://localhost:3003';
const DRIVER_POOL_SIZE = 40; // reuses the already-seeded load-test drivers
const CENTER = { lat: 40.7128, long: -74.006 };
const BURST_SIZES = [50, 100, 250, 500, 1000, 2000];

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

async function loginDriver(index: number): Promise<string> {
  const email = `load-test-driver-${index}@example.com`;
  const { token } = await postJson(`${AUTH_URL}/auth/login`, { email, password: LOAD_TEST_PASSWORD });
  return token;
}

async function updateLocation(token: string): Promise<void> {
  const lat = CENTER.lat + (Math.random() - 0.5) * 0.02;
  const long = CENTER.long + (Math.random() - 0.5) * 0.02;
  await postJson(`${LOCATION_URL}/location/update`, { lat, long }, token);
}

async function runBurst(tokens: string[], burstSize: number) {
  const start = Date.now();
  const calls = Array.from({ length: burstSize }, (_, i) => updateLocation(tokens[i % tokens.length]));
  const results = await Promise.allSettled(calls);
  const elapsedMs = Date.now() - start;
  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = burstSize - succeeded;
  const reqPerSec = succeeded / (elapsedMs / 1000);
  return { burstSize, succeeded, failed, elapsedMs, reqPerSec };
}

async function main() {
  console.log(`logging in ${DRIVER_POOL_SIZE} drivers (one-time cost, excluded from measurement)...`);
  const tokens = await Promise.all(Array.from({ length: DRIVER_POOL_SIZE }, (_, i) => loginDriver(i)));
  console.log(`✅ ${tokens.length} driver tokens ready\n`);

  console.log('burst size | succeeded | failed | elapsed ms | req/sec');
  console.log('-----------|-----------|--------|------------|--------');
  for (const burstSize of BURST_SIZES) {
    const r = await runBurst(tokens, burstSize);
    console.log(
      `${String(r.burstSize).padEnd(10)} | ${String(r.succeeded).padEnd(9)} | ${String(r.failed).padEnd(6)} | ${String(r.elapsedMs).padEnd(10)} | ${r.reqPerSec.toFixed(1)}`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
