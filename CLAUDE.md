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

**API surface (from the original design, as implemented so far):**
- `POST /auth/register` → `{ name, email, phone, password }` → `{ token, profileId, role: 'rider' }`
  (rider self-registration only - drivers aren't self-serve, since onboarding
  one needs vetting a public API can't do; driver accounts are created via
  the seed script for now, with a real driver registration/verification
  flow as its own later story)
- `POST /auth/login` → `{ email, password }` → `{ token, profileId, role }`
  (works for any role already in `Users` - not rider-only, since login
  itself doesn't grant anything, it just authenticates an existing account)
- `POST /ride/fare-estimate` → `{ source, destination }` → `Partial<Ride>` (pure calculation, no persistence)
- `PATCH /ride/request` → `Authorization: Bearer <token>` + `{ source, destination, fare }` → created `Ride` + `{ fareChanged }`
  (deviates from the original `{ rideId } → 200` spec — `riderId` comes from
  the verified token, never the body; fare is recomputed server-side and
  `fareChanged` flags if it differs from the quoted value)
- `POST /location/update` → `Authorization: Bearer <token>` + `{ lat, long }` → `{ driverId, lat, long }`
  (`driverId` comes from the verified token, same pattern as `/ride/request`;
  GEOADDs into Redis's `driver-locations` key, no DynamoDB involved)
- `GET /location/nearby-drivers?lat=&long=&radiusKm=` → `{ driverIds: string[] }`
  (no auth - read-only, called internally by `matching-service`, not scoped
  to any particular user's identity; GEOSEARCH, nearest-first)
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
- **Auth**: a `Users` table (PK: `email`, since that's the login lookup)
  holds credentials, separate from the `Riders`/`Drivers` profile tables —
  keeps password hashes away from anywhere a Rider/Driver object gets
  returned. Each `Users` row carries a `profileId` (the corresponding
  Rider/Driver id) so login needs one `GetItem`, not a second lookup;
  `Riders`/`Drivers` rows carry a `userId` back-reference. This was added
  deliberately as two ids per person (not one shared id) so one person
  being both a rider and a driver — a real thing in Uber's actual product
  — doesn't require a schema migration later. Passwords are hashed with
  Node's built-in `scrypt` (no extra dependency for something this
  security-sensitive); tokens are signed JWTs (`jsonwebtoken`) verified by
  any service via a shared helper in `@uber-clone/shared`, so every service
  checks identity the same way instead of re-implementing it.

## Current state

Scaffolded so far: Run `docker compose up -d && npm install && npm run create-tables` to get
local infra running with empty tables. Redis's host port is remapped to
`6381` (not the default `6379`) because other local projects already
occupy `6379` and `6380` — Node code connecting from the host must use
`6381`; containers connecting to Redis over the Docker network (e.g.
RedisInsight) use the internal `redis:6379`.

Done:
1. Seed script (`scripts/seed.ts`) — inserts one rider + one driver by hand,
   confirmed visible in the DynamoDB admin GUI.
2. `packages/ride-service` — `POST /ride/fare-estimate` (pure calculation,
   Haversine distance × rate, no persistence) and `PATCH /ride/request`
   (creates the real `Ride` row; requires a verified rider token).
3. `packages/auth-service` — `POST /auth/register` (rider self-service
   only — drivers can't self-register, since onboarding one needs vetting
   a public API can't do; driver accounts are created via the seed script
   for now) and `POST /auth/login` (works for any role already in `Users`).
   Inserted ahead of schedule once `/ride/request` needed a real `riderId`
   instead of a hardcoded placeholder. Schema is normalized: `Users` (PK
   `email`, GSI `UserIdIndex` on `id`) holds everything common to both
   roles - `name`, `email`, `phone`, credentials; `Riders`/`Drivers` hold
   only `userId` + role-specific fields (`paymentMethods` /
   `vehicle`+`status`) + their own `createdAt`.
4. `packages/location-service` — `POST /location/update`, first real
   Redis usage. `GEOADD`s into a single `driver-locations` key (one key
   so `GEOSEARCH` can scan across every driver later). Known gap, left
   for deliberately later: Redis GEO sets can't expire individual members,
   so a driver who goes offline just stays in the set with a stale
   location - no consumer needs staleness filtering yet, so this is
   deferred to `matching-service`, likely via a companion per-driver key
   with its own TTL.
5. `packages/matching-service` — **first slice only**, not the full
   matching flow. `ride-service` now `LPUSH`es a `rideId` onto Redis's
   `ride-request-queue` after creating a `Ride` (the "Ride Request Queue"
   from the architecture doc - decouples ride creation from matching).
   `matching-service` is a background worker (no HTTP server yet, nothing
   calls it) that `BRPOP`s that queue, calls `location-service`'s new
   `GET /location/nearby-drivers` (GEOSEARCH), filters candidates to
   `status === 'available'`, and attempts an atomic
   `SET driver-lock:<driverId> <rideId> NX EX 10` on the first available
   one. Stops there - just proves queue → search → availability → lock
   works. Explicitly NOT built yet: sending a real notification, waiting
   for accept/decline, retrying the next candidate on timeout/decline,
   and updating `Ride`/`Driver` status on a match.

## Immediate next steps (in order)

1. The rest of `matching-service`: `PATCH /ride/driver/accept` (which
   service owns it - probably `matching-service`, since it holds the
   lock), how an accept reaches the *waiting* matching loop (a blocking
   10s wait inside a request handler doesn't fit Node's model well -
   likely polling or an in-process event emitter keyed by `rideId`),
   retry-next-candidate on decline/timeout, and updating
   `Ride.status → 'matched'` / `Driver.status → 'in_ride'` on success.
   The driver-location-staleness question flagged above belongs here too.
2. `notification-service` (can likely stay a stub/log for a while).

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
