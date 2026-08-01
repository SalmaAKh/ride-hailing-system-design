# Uber Clone — Learning Project

A small ride-hailing system, built incrementally to learn: DynamoDB access-
pattern modeling, Redis (geo-sharded location search, TTL locks, blocking
queues), JWT auth, and a monorepo services architecture. The full loop —
register → fare estimate → ride request → matching → accept → pickup →
drop-off → completed — works end to end.

For the *why* behind every decision below (not just the *what*), see
[`CLAUDE.md`](./CLAUDE.md) — it's the living design doc this project was
built from, kept in sync as things changed.

## Architecture

```
                    ┌──────────────┐
  rider/driver ───▶ │ auth-service │  (3002)  register / login, issues JWTs
                    └──────────────┘
                           │
  rider ──▶ ┌──────────────────────┐         ┌──────────────────┐
            │     ride-service     │ ───────▶ │  Ride Request     │
            │        (3001)        │  LPUSH   │  Queue (Redis)    │
            │ fare-estimate/request│          └─────────┬─────────┘
            │ driver/accept/update │                    │ BRPOP
            └──────────────────────┘                    ▼
                           ▲              ┌───────────────────────┐
                  accept/  │  LPUSH       │   matching-service     │
                  decline  │  ride-response│  (background worker,  │
                  signal   └──────────────│   no HTTP port)        │
                                          └────────────┬───────────┘
                                                        │ GET nearby-drivers
                                                        ▼
                                          ┌───────────────────────┐
  driver ──▶ ┌────────────────┐          │   location-service     │
             │notification-svc│◀─────────│        (3003)          │
             │     (3004)     │  notify  │ geo-sharded GEOSEARCH   │
             └────────────────┘          └───────────┬─────────────┘
                                                        │
                                    ┌───────────────────┴──────────────────┐
                                    ▼                                       ▼
                            DynamoDB Local (8000)                    Redis (6381)
                       Riders/Drivers/Rides/Users              locations, locks, heartbeats,
                                                                  queues (ephemeral only)
```

## Stack

- **Node.js + TypeScript**, npm workspaces monorepo, one package per service, **Fastify** for HTTP
- **DynamoDB Local** (via Docker) — primary data store, multi-table
- **Redis** — driver locations (geo-sharded GEO sets), TTL locks/heartbeats, blocking-list queues
- **JWT** (`jsonwebtoken`) for auth, passwords hashed with Node's built-in `scrypt`

## Prerequisites

- Docker + Docker Compose
- Node.js 20+ (Node 22 recommended — this repo has hit issues with npm under Node 14/older)

## Setup

```bash
# 1. Start local infra (DynamoDB Local, its admin UI, Redis, RedisInsight)
docker compose up -d

# 2. Install dependencies
npm install

# 3. Create the DynamoDB tables
npm run create-tables

# 4. Seed one rider + one driver with known credentials (see "Seeded test accounts" below)
npm run seed
```

> DynamoDB Local runs `-inMemory`, so data resets whenever that container
> restarts. Just re-run `npm run create-tables && npm run seed` after a restart.

## Running the services

Each service runs in its own terminal tab (five total; `matching-service`
has no HTTP server, it's a background worker):

```bash
npm run dev --workspace=@uber-clone/auth-service         # :3002
npm run dev --workspace=@uber-clone/ride-service          # :3001
npm run dev --workspace=@uber-clone/location-service      # :3003
npm run dev --workspace=@uber-clone/matching-service       # no port - BRPOPs the ride-request queue
npm run dev --workspace=@uber-clone/notification-service  # :3004
```

## Watching it live — GUIs

Both come up automatically with `docker compose up -d`:

- **DynamoDB Admin** — **http://localhost:8001** — browse `Riders`, `Drivers`,
  `Rides`, `Users` tables. Use the **Scan** view on a table to see all rows;
  click a row's **View** link for the raw item.
- **RedisInsight** — **http://localhost:5540** — browse live Redis keys
  (driver locks, heartbeats, geo-sharded location sets, queues). First time
  only: click **Add database**, and for the Connection URL use
  `redis://default@redis:6379` — **not** `localhost:6381` — RedisInsight runs
  *inside* Docker's network, where the container is reachable as `redis` on
  its internal port 6379 (the `6381` remap is only for connecting from your
  host machine, e.g. Node code running outside Docker).
  - Useful keys to watch during a test: `driver-locations:<latCell>:<longCell>`
    (GEO sets, one per ~11km grid cell), `driver-lock:<driverId>` (TTL locks,
    watch them appear/expire), `driver-heartbeat:<driverId>`, `driver-cell:<driverId>`,
    `ride-request-queue` / `ride-response:<rideId>` (the blocking-list queues).

Both GUIs support live refresh, so you can leave them open in a browser tab
while running a test below and watch rows/keys appear in real time.

## Seeded test accounts

`npm run seed` creates these (password for both: `seed-password-123`):

| Role | Email | Name |
|---|---|---|
| Rider | `salmamcu@gmail.com` | Salma Khater |
| Driver | `jordan.reyes@example.com` | Jordan Reyes |

## Testing

### Option A — automated, full lifecycle (recommended)

With all five services running:

```bash
npm run test-matching-flow
```

Runs the entire loop against the seeded accounts above — login driver,
refresh their location, login rider, request a ride, accept it, mark
picked up, dropped off, and completed — with no manual copy-paste between
steps. (Manual `curl`-by-hand testing is easy to lose to timing: driver
locks expire after 10s and heartbeats after 30s, so pasting commands one
at a time can race those TTLs. This script doesn't.)

### Option B — manual, step by step

```bash
# Register a rider
curl -X POST http://localhost:3002/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Rider", "email": "test@example.com", "phone": "+1-555-0100", "password": "correcthorsebattery"}'

# Login (rider or driver - works for any registered role)
curl -X POST http://localhost:3002/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "salmamcu@gmail.com", "password": "seed-password-123"}'

# Fare estimate (no auth, pure calculation)
curl -X POST http://localhost:3001/ride/fare-estimate \
  -H "Content-Type: application/json" \
  -d '{"source": {"lat": 40.7128, "long": -74.0060}, "destination": {"lat": 40.7484, "long": -73.9857}}'

# Request a ride (rider token from login)
curl -X PATCH http://localhost:3001/ride/request \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <RIDER_TOKEN>" \
  -d '{"source": {"lat": 40.7128, "long": -74.0060}, "destination": {"lat": 40.7484, "long": -73.9857}, "fare": 10}'

# Driver: refresh location (needed before they can be matched - also sets their 30s heartbeat)
curl -X POST http://localhost:3003/location/update \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <DRIVER_TOKEN>" \
  -d '{"lat": 40.7128, "long": -74.0060}'

# Driver: accept (rideId from the /ride/request response; do this within ~10s of requesting)
curl -X PATCH http://localhost:3001/ride/driver/accept \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <DRIVER_TOKEN>" \
  -d '{"rideId": "<RIDE_ID>", "accept": true}'

# Driver: pickup / dropoff / completed
curl -X PATCH http://localhost:3001/ride/driver/update \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <DRIVER_TOKEN>" \
  -d '{"rideId": "<RIDE_ID>", "status": "picked_up"}'
```

### Load testing — proving concurrency correctness

These fire many concurrent requests to check that the driver-lock mechanism
(`SET driver-lock:<driverId> <rideId> NX EX 10`) never lets two riders get
matched to the same driver at once, even under real contention:

```bash
# Seed N disposable drivers + 2N riders (shared password: load-test-password-123)
npm run seed-load-test -- --drivers=20 --riders=40

# Fire all rider requests concurrently; each matched driver auto-accepts and
# drives the ride through pickup/dropoff/completed
npm run load-test -- --drivers=20 --riders=40 --waitSeconds=30
```

Reports a status breakdown and explicitly checks for double-booking (any
`driverId` assigned to more than one ride). Scale the numbers up to see
where this machine's local `dynamodb-local`/Redis setup starts to strain —
correctness held through 40 drivers / 80 riders in testing; throughput (not
correctness) is what degrades under load, which is expected for a single
Docker-container `dynamodb-local` instance sharing a laptop with everything
else running on it.

### Location-update throughput micro-benchmark

```bash
npm run location-update-benchmark
```

Measures raw `POST /location/update` throughput alone (not the full ride
cycle) at increasing concurrency — the number this project's back-of-
envelope capacity calculation against the "600k TPS, 3M drivers polling
every 5s" non-functional requirement is based on. See the geo-sharding
design decision in `CLAUDE.md` for what that calculation implied and how
it shaped `location-service`'s Redis key design.

## Repo layout

```
packages/
  shared/               # entity types, DynamoDB/Redis clients, JWT + password
                         # helpers, Redis key-naming conventions - imported by every service
  auth-service/         # POST /auth/register, POST /auth/login
  ride-service/         # fare-estimate, ride/request, driver/accept, driver/update
  location-service/     # location/update, location/nearby-drivers (geo-sharded GEOSEARCH)
  matching-service/     # background worker: BRPOP ride-request-queue, lock + notify + wait
  notification-service/ # stub: logs a notification, no real push integration
scripts/
  create-tables.ts             # provisions DynamoDB tables + GSIs
  seed.ts                      # one known rider + driver, for manual testing
  test-matching-flow.ts        # automated full-lifecycle smoke test
  seed-load-test.ts            # bulk disposable drivers/riders for load testing
  load-test.ts                 # concurrent ride-request + auto-accept load test
  load-test-config.ts          # shared constant between the two load-test scripts above
  location-update-benchmark.ts # isolated /location/update throughput benchmark
docker-compose.yml   # dynamodb-local, dynamodb-admin, redis, redisinsight
```

## Design decisions (and why)

The short version — full reasoning for each lives in `CLAUDE.md`:

- **Multi-table DynamoDB, not single-table**, deliberately, until there's a
  working app to compare a single-table refactor against.
- **GSIs modeled from known access patterns only** (`Rides.DriverIdIndex`/
  `RiderIdIndex`, `Users.UserIdIndex`) — never speculative.
- **Auth is normalized**: `Users` (credentials + name/email/phone) is
  separate from `Riders`/`Drivers` (profile + role-specific fields), linked
  by `userId`/`profileId` — so one person could hold both roles later
  without a schema migration.
- **Driver locations/locks/heartbeats/queues live only in Redis, never
  DynamoDB** — ephemeral by nature, and Redis does geo queries and TTL
  expiry natively.
- **Driver locations are geo-sharded by grid cell**, not one global GEO
  key — motivated by measuring that a single `location-service` instance
  plateaus around ~3-4k location-updates/sec, which doesn't come close to
  the 600k TPS target on its own.
- **Blocking Redis commands (`BRPOP`/`BLPOP`) each need their own
  connection** — sharing one connection with other commands would let one
  blocking call silently stall everything else on it.

## Status

The core loop (fare estimate → request → match → accept → pickup → drop-off
→ completed) is complete and tested, including under concurrent load.
Natural next candidates: notifying the *rider* when matched (currently only
the driver gets `/notify`'d), a real push-notification integration, the
deliberately-deferred single-table DynamoDB refactor, or automated tests.
