/**
 * Seeds one hand-crafted rider and driver into DynamoDB, so we can confirm
 * real items round-trip correctly through the DynamoDB admin GUI before
 * any service code exists.
 *
 * Each person is a Users row (credentials + name/email/phone) plus a
 * Riders/Drivers row (userId + role-specific fields only), mirroring
 * exactly what auth-service's real /auth/register does - just as two
 * plain PutCommands instead of a transaction, since this is hand-seeded
 * data for local testing, not a path real users go through.
 *
 * Run with: npm run seed
 */
import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, hashPassword, type User, type Rider, type Driver } from '@uber-clone/shared';

const SEED_PASSWORD = 'seed-password-123'; // local test data only

async function main() {
  const passwordHash = await hashPassword(SEED_PASSWORD);
  const now = new Date().toISOString();

  const riderUserId = randomUUID();
  const riderId = randomUUID();

  const riderUser: User = {
    id: riderUserId,
    email: 'salmamcu@gmail.com',
    name: 'Salma Khater',
    phone: '+1-555-0100',
    passwordHash,
    role: 'rider',
    profileId: riderId,
    createdAt: now,
  };

  const rider: Rider = {
    id: riderId,
    userId: riderUserId,
    paymentMethods: [{ id: randomUUID(), type: 'card', last4: '4242', isDefault: true }],
    createdAt: now,
  };

  const driverUserId = randomUUID();
  const driverId = randomUUID();

  const driverUser: User = {
    id: driverUserId,
    email: 'jordan.reyes@example.com',
    name: 'Jordan Reyes',
    phone: '+1-555-0200',
    passwordHash,
    role: 'driver',
    profileId: driverId,
    createdAt: now,
  };

  const driver: Driver = {
    id: driverId,
    userId: driverUserId,
    vehicle: { make: 'Toyota', model: 'Camry', year: 2021, plate: 'ABC-1234' },
    status: 'available',
    createdAt: now,
  };

  await ddb.send(new PutCommand({ TableName: TABLES.USERS, Item: riderUser }));
  await ddb.send(new PutCommand({ TableName: TABLES.RIDERS, Item: rider }));
  console.log(`✅ seeded rider: ${rider.id} (${riderUser.name})`);

  await ddb.send(new PutCommand({ TableName: TABLES.USERS, Item: driverUser }));
  await ddb.send(new PutCommand({ TableName: TABLES.DRIVERS, Item: driver }));
  console.log(`✅ seeded driver: ${driver.id} (${driverUser.name})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
