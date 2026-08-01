/**
 * Creates the local DynamoDB tables for this project.
 *
 * Multi-table design (see README for why we chose this over single-table
 * for now). Each table's GSIs are modeled directly off known access
 * patterns, not "whatever columns exist":
 *
 *   Riders  -> PK: id                     (get rider by id)
 *   Drivers -> PK: id                     (get driver by id)
 *   Rides   -> PK: id                     (get ride by id)
 *              GSI DriverIdIndex          (get rides for a driver, newest first)
 *              GSI RiderIdIndex           (get rides for a rider, newest first)
 *   Users   -> PK: email                  (look up credentials at login)
 *              GSI UserIdIndex            (resolve a Rider/Driver's userId
 *                                           back to name/email/phone, e.g.
 *                                           for "my profile" or notifications)
 *
 * Run with: npm run create-tables
 */
import {
  CreateTableCommand,
  CreateTableCommandInput,
  DynamoDBClient,
  ListTablesCommand,
  ResourceInUseException,
  ScalarAttributeType,
} from '@aws-sdk/client-dynamodb';

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
  },
});

async function createTable(input: CreateTableCommandInput) {
  try {
    await client.send(new CreateTableCommand(input));
    console.log(`✅ created table: ${input.TableName}`);
  } catch (err) {
    if (err instanceof ResourceInUseException) {
      console.log(`↪️  table already exists, skipping: ${input.TableName}`);
    } else {
      throw err;
    }
  }
}

async function main() {
  const existing = await client.send(new ListTablesCommand({}));
  console.log('Existing tables before run:', existing.TableNames);

  await createTable({
    TableName: 'Riders',
    BillingMode: 'PAY_PER_REQUEST', // on-demand: no capacity planning while learning
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
  });

  await createTable({
    TableName: 'Drivers',
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: ScalarAttributeType.S }],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
  });

  await createTable({
    TableName: 'Rides',
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: ScalarAttributeType.S },
      { AttributeName: 'driverId', AttributeType: ScalarAttributeType.S },
      { AttributeName: 'riderId', AttributeType: ScalarAttributeType.S },
      { AttributeName: 'createdAt', AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'DriverIdIndex',
        KeySchema: [
          { AttributeName: 'driverId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'RiderIdIndex',
        KeySchema: [
          { AttributeName: 'riderId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  });

  await createTable({
    TableName: 'Users',
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'email', AttributeType: ScalarAttributeType.S },
      { AttributeName: 'id', AttributeType: ScalarAttributeType.S },
    ],
    KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'UserIdIndex',
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  });

  const after = await client.send(new ListTablesCommand({}));
  console.log('Existing tables after run:', after.TableNames);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
