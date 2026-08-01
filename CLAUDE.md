# Uber Clone — Project Context

This is a **learning project**. The primary goal is not just a working app —
it's understanding the tools and patterns as we go (DynamoDB access-pattern
modeling, Redis geo/TTL usage, service architecture). When implementing
anything, briefly explain *why*, especially for anything non-trivial
(DynamoDB indexing choices, Redis commands, consistency/locking logic).
Don't just dump code silently. Ask before making significant architecture
decisions instead of assuming — this project is being built collaboratively,
one deliberate step at a time, not all at once.

## System design

Adapted from a "Design Uber" system design interview breakdown.

**Functional requirements**
1. Riders input a start location + destination and get a fare estimate.
2. Riders can request a ride based on the estimated fare.
3. Upon request, riders are matched with a nearby, available driver.
4. Drivers can accept/decline a request and navigate to pickup/drop-off.

**Non-functional requirements**
1. Low-latency matching: < 1 minute to match or fail.
2. Strong consistency in matching — a driver must never be assigned to more
   than one ride at the same time.
3. High throughput, especially at peak (design target: ~600k TPS on driver
   location updates, from 3M active drivers polling every 5s).

**Core entities:** Rider, Driver, Ride, Location (see
`packages/shared/src/types.ts` for the actual TS shapes).

**API surface (from the original design):**
- `POST /ride/fare-estimate` → `{ source, destination }` → `Partial<Ride>`
- `PATCH /ride/request` → `{ rideId }` → `200`
- `POST /location/update` → `{ lat, long }`
- `PATCH /ride/driver/accept` → `{ rideId, accept: boolean }`
- `PATCH /ride/driver/update` → `{ rideId, status: 'pickedup' | 'droppedoff' }`

**High-level architecture:** API Gateway → Ride Service (fare estimate,
talks to a 3rd-party mapping API) → Ride Request Queue → Ride Matching
Service (loops candidate drivers, takes a TTL lock per driver, sends a
push notification, waits ~10s for accept, repeats on timeout/decline) →
Location Service backed by Redis GEO commands → Primary DB is DynamoDB.
Driver locations and driver locks are **ephemeral and live only in Redis**,
never in DynamoDB.

## Stack & key decisions (already made — don't re-litigate these without discussion)

- **TypeScript + Node.js**, npm workspaces monorepo, one package per service.
- **Fastify** for HTTP services (chosen deliberately as a "new tool" over
  Express).
- **Local infra via Docker Compose**: `amazon/dynamodb-local` (in-memory),
  `dynamodb-admin` (GUI on :8001), `redis:7`, `redis/redisinsight` (GUI on
  :5540). Nothing here touches real AWS or costs money.
- **DynamoDB: multi-table for now, not single-table.** Single-table's whole
  payoff (fewer round trips) only shows up at high scale, which a local
  learning project will never hit — so we'd pay the full modeling cost
  (composite keys, overloaded GSIs) with none of the benefit. Plan: build
  the app multi-table first, then do a **dedicated single-table refactor
  later as an explicit lesson**, once there's a working app to compare
  against. Don't preemptively refactor to single-table.
- GSIs are modeled strictly from known access patterns, not spec'd
  speculatively. Current `Rides` table has `DriverIdIndex` and
  `RiderIdIndex` (composite key with `createdAt` as range key) because
  "rides for this driver/rider, newest first" are the only two patterns
  known so far. New GSIs should only be added when a real query pattern
  demands one — flag it and explain the pattern before adding it.
- Redis holds driver locations (via `GEOADD`/`GEOSEARCH` — geohashing was
  flagged as new/unfamiliar, so explain these commands when first used)
  and per-driver TTL locks (used by the matching loop to guarantee a
  driver is never sent two ride requests at once).

## Current state

Scaffolded so far: Run `docker compose up -d && npm install && npm run create-tables` to get
local infra running with empty tables. Redis's host port is remapped to
`6381` (not the default `6379`) because other local projects already
occupy `6379` and `6380` — Node code connecting from the host must use
`6381`; containers connecting to Redis over the Docker network (e.g.
RedisInsight) use the internal `redis:6379`.

Nothing else exists yet — no seed data, no services beyond local infra.

## Immediate next steps (in order)

1. A small seed script to insert one rider + one driver by hand, so we can
   confirm real items show up correctly in the DynamoDB admin GUI.
2. `packages/ride-service`: Fastify service implementing
   `POST /ride/fare-estimate` first (simplest possible fare calc — e.g.
   straight-line distance × rate — no real mapping API yet) and
   `PATCH /ride/request` next. This is the first real DynamoDB read/write
   wiring through a service.
3. `location-service` + Redis GEO usage (the geohashing lesson).
4. `matching-service` + the TTL driver-lock consistency logic.
5. `notification-service` (can likely stay a stub/log for a while).

Confirm scope with me before jumping ahead of step in progress.

## Git workflow

This repo is public on GitHub — commit history doubles as a public work
log, so treat it that way.

- No automated git actions. Never run `git add`, `git commit`, or
  `git push`. After finishing each meaningful unit of work (a full
  service, a completed step from "Immediate next steps", a passing
  script, a real bugfix), stop and write a suggested commit message —
  the developer stages, commits, and pushes it themselves.
- Write commit messages in conventional-commit style (`feat:`, `fix:`,
  `docs:`, `chore:`, `refactor:`), with a short body explaining *why*
  when the change isn't self-evident. These are public — write them for
  someone else reading the history later, not "wip" or "fix stuff".
- Never commit secrets, `.env` files, or credentials. `.gitignore`
  already covers `node_modules`/`dist`/`.env`/`*.log` — keep it updated
  as new generated artifacts show up.
- Don't squash or rewrite history that's already been pushed.
