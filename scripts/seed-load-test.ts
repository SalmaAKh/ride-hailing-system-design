/**
 * Seeds N drivers and M riders (identities only, in DynamoDB) for the
 * concurrent-matching load test. Separate from scripts/seed.ts, which
 * seeds exactly one well-known rider + driver for manual testing - this
 * one is disposable bulk data.
 *
 * All load-test users share a single password hash instead of hashing N
 * times - scrypt is deliberately expensive, and that cost belongs in
 * load-test.ts's login phase (what we're actually testing), not here.
 *
 * Run with: npm run seed-load-test -- --drivers=10 --riders=20
 */
import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, hashPassword, type User, type Rider, type Driver } from '@uber-clone/shared';
import { LOAD_TEST_PASSWORD } from './load-test-config';

function parseArg(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? Number(arg.split('=')[1]) : fallback;
}

async function createPerson(role: 'rider' | 'driver', index: number, passwordHash: string) {
  const userId = randomUUID();
  const profileId = randomUUID();
  const now = new Date().toISOString();

  const user: User = {
    id: userId,
    email: `load-test-${role}-${index}@example.com`,
    name: `Load Test ${role} ${index}`,
    phone: '+1-555-0000',
    passwordHash,
    role,
    profileId,
    createdAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLES.USERS, Item: user }));

  if (role === 'rider') {
    const rider: Rider = { id: profileId, userId, paymentMethods: [], createdAt: now };
    await ddb.send(new PutCommand({ TableName: TABLES.RIDERS, Item: rider }));
  } else {
    const driver: Driver = {
      id: profileId,
      userId,
      vehicle: { make: 'Toyota', model: 'Corolla', year: 2022, plate: `LT-${index}` },
      status: 'available',
      createdAt: now,
    };
    await ddb.send(new PutCommand({ TableName: TABLES.DRIVERS, Item: driver }));
  }
}

async function main() {
  const driverCount = parseArg('drivers', 10);
  const riderCount = parseArg('riders', 20);

  console.log(`seeding ${driverCount} drivers and ${riderCount} riders...`);
  const passwordHash = await hashPassword(LOAD_TEST_PASSWORD);

  for (let i = 0; i < driverCount; i++) {
    await createPerson('driver', i, passwordHash);
  }
  for (let i = 0; i < riderCount; i++) {
    await createPerson('rider', i, passwordHash);
  }

  console.log(`✅ seeded ${driverCount} drivers, ${riderCount} riders (password: ${LOAD_TEST_PASSWORD})`);

  // @uber-clone/shared's barrel export opens a Redis connection as an
  // import side effect (redis-client.ts), even though this script never
  // touches it - that keeps the event loop alive forever otherwise.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
