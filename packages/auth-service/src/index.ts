import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLES, signToken, hashPassword, verifyPassword, type Rider, type User } from '@uber-clone/shared';

const app = Fastify({ logger: true });

// Rider self-registration only. Drivers aren't self-serve - onboarding one
// means vetting (license, vehicle, background check) that a public API
// can't do, so for now driver accounts are created via the seed script
// instead. A driver registration/verification flow is its own later story.
const ROLE = 'rider' as const;

app.post<{
  Body: { name: string; email: string; phone: string; password: string };
}>(
  '/auth/register',
  {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'email', 'phone', 'password'],
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          password: { type: 'string', minLength: 8 },
        },
      },
    },
  },
  async (request, reply) => {
    const { name, email, phone, password } = request.body;

    const userId = randomUUID();
    const profileId = randomUUID();
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();

    const user: User = { id: userId, email, name, phone, passwordHash, role: ROLE, profileId, createdAt: now };
    const rider: Rider = { id: profileId, userId, paymentMethods: [], createdAt: now };

    try {
      // Both writes succeed or neither does - a TransactWriteCommand across
      // Users + Riders, instead of two separate PutCommands, so we never
      // end up with credentials but no profile (or vice versa) if the
      // second write fails. The condition on the Users put also closes a
      // race that a separate "check email, then write" would leave open:
      // two concurrent registrations for the same email can't both succeed.
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLES.USERS,
                Item: user,
                ConditionExpression: 'attribute_not_exists(email)',
              },
            },
            {
              Put: { TableName: TABLES.RIDERS, Item: rider },
            },
          ],
        }),
      );
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        return reply.status(409).send({ error: 'email already registered' });
      }
      throw err;
    }

    const token = signToken({ userId, profileId, role: ROLE });
    return reply.status(201).send({ token, profileId, role: ROLE });
  },
);

app.post<{ Body: { email: string; password: string } }>(
  '/auth/login',
  {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string' },
          password: { type: 'string' },
        },
      },
    },
  },
  async (request, reply) => {
    const { email, password } = request.body;

    const result = await ddb.send(new GetCommand({ TableName: TABLES.USERS, Key: { email } }));
    const user = result.Item as User | undefined;

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      // Same error for "no such user" and "wrong password" - confirming
      // which one it was would let an attacker enumerate registered emails.
      return reply.status(401).send({ error: 'invalid email or password' });
    }

    const token = signToken({ userId: user.id, profileId: user.profileId, role: user.role });
    return reply.send({ token, profileId: user.profileId, role: user.role });
  },
);

const port = Number(process.env.PORT ?? 3002);

app.listen({ port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
