/**
 * Seeds one hand-crafted rider and driver into DynamoDB, so we can confirm
 * real items round-trip correctly through the DynamoDB admin GUI before
 * any service code exists.
 *
 * Uses the shared DocumentClient (`ddb`) and table names (`TABLES`) from
 * @uber-clone/shared instead of a raw DynamoDBClient — the DocumentClient
 * lets us pass plain JS objects (matching the Rider/Driver interfaces
 * directly) instead of hand-writing DynamoDB's { S: 'foo' } attribute
 * format.
 *
 * Run with: npm run seed
 */
import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, type Rider, type Driver } from '@uber-clone/shared';

async function main() {
  const rider: Rider = {
    id: randomUUID(),
    name: 'Salma Khater',
    email: 'salmamcu@gmail.com',
    phone: '+1-555-0100',
    paymentMethods: [
      { id: randomUUID(), type: 'card', last4: '4242', isDefault: true },
    ],
    createdAt: new Date().toISOString(),
  };

  const driver: Driver = {
    id: randomUUID(),
    name: 'Jordan Reyes',
    email: 'jordan.reyes@example.com',
    phone: '+1-555-0200',
    vehicle: { make: 'Toyota', model: 'Camry', year: 2021, plate: 'ABC-1234' },
    status: 'available',
    createdAt: new Date().toISOString(),
  };

  await ddb.send(new PutCommand({ TableName: TABLES.RIDERS, Item: rider }));
  console.log(`✅ seeded rider: ${rider.id} (${rider.name})`);

  await ddb.send(new PutCommand({ TableName: TABLES.DRIVERS, Item: driver }));
  console.log(`✅ seeded driver: ${driver.id} (${driver.name})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
