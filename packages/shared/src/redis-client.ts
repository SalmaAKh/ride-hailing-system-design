import Redis from 'ioredis';

// Points at the local redis container by default. Host port is remapped to
// 6381 (not 6379) because other local projects already occupy 6379/6380 -
// see CLAUDE.md. Override REDIS_URL to point elsewhere later.
export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6381');

export const REDIS_KEYS = {
  // Single GEO set holding every driver's last-known location, keyed by
  // driverId. GEOSEARCH-style radius queries need every candidate in one
  // key - there's no way to search "nearby" across scattered per-driver keys.
  DRIVER_LOCATIONS: 'driver-locations',
  // The "Ride Request Queue" from the architecture doc - ride-service
  // LPUSHes a rideId here after creating a Ride; matching-service BRPOPs
  // it, decoupling ride creation from the (potentially slow) matching loop.
  RIDE_REQUEST_QUEUE: 'ride-request-queue',
} as const;

// Prefix for per-driver TTL locks (SET NX EX) that stop the same driver
// getting offered two rides at once during matching.
export const driverLockKey = (driverId: string) => `driver-lock:${driverId}`;
