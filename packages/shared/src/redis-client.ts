import Redis from 'ioredis';

// Points at the local redis container by default. Host port is remapped to
// 6381 (not 6379) because other local projects already occupy 6379/6380 -
// see CLAUDE.md. Override REDIS_URL to point elsewhere later.
export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6381');

export const REDIS_KEYS = {
  // The "Ride Request Queue" from the architecture doc - ride-service
  // LPUSHes a rideId here after creating a Ride; matching-service BRPOPs
  // it, decoupling ride creation from the (potentially slow) matching loop.
  RIDE_REQUEST_QUEUE: 'ride-request-queue',
} as const;

// Prefix for per-driver TTL locks (SET NX EX) that stop the same driver
// getting offered two rides at once during matching.
export const driverLockKey = (driverId: string) => `driver-lock:${driverId}`;

// Set (with a short TTL) every time a driver calls POST /location/update.
// A missing key means no update has landed recently, even if DynamoDB
// still says status: 'available' - catches a driver whose app crashed or
// lost connectivity without anyone explicitly marking them offline.
export const driverHeartbeatKey = (driverId: string) => `driver-heartbeat:${driverId}`;

// Driver locations are geo-sharded into one GEO key per grid cell, rather
// than a single global key, so no single Redis key/node has to absorb
// every driver update in the system - see CLAUDE.md for the back-of-
// envelope math that motivated this. Cell size is in degrees (~11km near
// mid-latitudes), deliberately bigger than the 5km search radius so a 3x3
// neighboring-cell search is always enough to catch boundary cases.
export const GEO_CELL_SIZE_DEGREES = 0.1;

export function geoCell(lat: number, long: number): { latCell: number; longCell: number } {
  return {
    latCell: Math.floor(lat / GEO_CELL_SIZE_DEGREES),
    longCell: Math.floor(long / GEO_CELL_SIZE_DEGREES),
  };
}

export function driverLocationsKey(latCell: number, longCell: number): string {
  return `driver-locations:${latCell}:${longCell}`;
}

// Tracks which cell key a driver currently lives in. Needed by both
// services: location-service reads it to ZREM a driver from their old
// cell when they move to a new one (the existing heartbeat/status
// staleness check wouldn't catch a stale cell entry, since both stay
// fresh regardless of which cell gets written to), and matching-service
// reads it to know which cell's key to ZREM from when it finds a driver
// stale during matching.
export const driverCellKey = (driverId: string) => `driver-cell:${driverId}`;

// Per-ride handoff queue: ride-service LPUSHes 'accepted'/'declined' here
// once a driver responds; matching-service BLPOPs it while waiting, so an
// accept/decline in one process reaches the waiting loop in another
// without any shared memory - same primitive as the ride-request queue,
// just scoped to a single ride instead of global.
export const rideResponseKey = (rideId: string) => `ride-response:${rideId}`;
