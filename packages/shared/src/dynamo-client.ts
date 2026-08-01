import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Points at dynamodb-local by default. Override DYNAMODB_ENDPOINT to hit
// real AWS later without touching any service code.
const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
  },
});

// DocumentClient lets us work with plain JS objects instead of the
// { S: 'foo' } / { N: '1' } attribute-value wire format.
export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLES = {
  RIDERS: 'Riders',
  DRIVERS: 'Drivers',
  RIDES: 'Rides',
} as const;

export const RIDES_DRIVER_ID_INDEX = 'DriverIdIndex';
export const RIDES_RIDER_ID_INDEX = 'RiderIdIndex';
