# Uber Clone — Learning Project

A small ride-hailing system, built incrementally to learn: DynamoDB (local),
Redis (geohashing + TTL locks), and a monorepo services architecture.

## Stack

- **Node.js + TypeScript**, npm workspaces monorepo
- **DynamoDB Local** (via Docker) — primary data store, multi-table for now
- **Redis** — driver locations (geo) + driver locks (TTL), for the matching service
- Services will be added one at a time under `packages/`

## Prerequisites

- Docker + Docker Compose
- Node.js 20+

## Setup

```bash
# 1. Start local infra (DynamoDB Local, its admin UI, Redis)
docker compose up -d

# 2. Install dependencies
npm install

# 3. Create the DynamoDB tables
npm run create-tables
```

Then open **http://localhost:8001** to browse your local DynamoDB tables
in a GUI (dynamodb-admin).

Redis is reachable at `localhost:6379` (no auth locally).

> Note: DynamoDB Local runs `-inMemory`, so data resets whenever the
> container restarts. Just re-run `npm run create-tables` after a restart.

## Repo layout

```
packages/
  shared/        # entity types + DynamoDB client, imported by every service
scripts/
  create-tables.ts   # provisions the 3 DynamoDB tables + GSIs
docker-compose.yml   # dynamodb-local, dynamodb-admin, redis
```

## Design decisions (and why)

**Multi-table DynamoDB, not single-table.** Single-table design's whole
payoff is cutting round-trips at high scale, which you can't feel on a local
learning project — you'd pay the modeling cost (composite keys, overloaded
GSIs) without ever seeing the benefit. We're starting multi-table, and doing
a single-table refactor later as a dedicated exercise once the app works
end-to-end and there's something real to compare against.

**GSIs modeled from access patterns, not "just in case."** `Rides` has
`DriverIdIndex` and `RiderIdIndex` because "show me a driver's/rider's ride
history" are the only two query patterns we know we need beyond
get-by-id. This is the core DynamoDB mindset: define your access patterns
*before* the table, not after.

**Real-time data (driver location, driver locks) lives in Redis, not
DynamoDB.** It's ephemeral and needs to be fast — geo queries and TTL
expiry are things Redis does natively that DynamoDB doesn't.

## What's next

- [ ] `ride-service`: fare estimate + ride request endpoints (Fastify)
- [ ] `location-service`: Redis GEOADD / GEOSEARCH for driver locations
- [ ] `matching-service`: matching loop + driver TTL locks (the consistency
      guarantee from the design: never double-book a driver)
- [ ] `notification-service`
