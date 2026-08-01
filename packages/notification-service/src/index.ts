import Fastify from 'fastify';

const app = Fastify({ logger: true });

// Stub for now - a real box in the architecture that matching-service
// calls, rather than a console.log buried inside matching-service itself.
// No real push integration (APNs/FCM) yet; that's a separate integration
// this project isn't about.
app.post<{ Body: { driverId: string; rideId: string } }>(
  '/notify',
  {
    schema: {
      body: {
        type: 'object',
        required: ['driverId', 'rideId'],
        properties: {
          driverId: { type: 'string' },
          rideId: { type: 'string' },
        },
      },
    },
  },
  async (request, reply) => {
    const { driverId, rideId } = request.body;
    app.log.info(`notifying driver ${driverId} about ride ${rideId}`);
    return reply.send({ notified: true });
  },
);

const port = Number(process.env.PORT ?? 3004);

app.listen({ port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
