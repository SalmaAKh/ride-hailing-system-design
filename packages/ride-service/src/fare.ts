import type { Coordinates } from '@uber-clone/shared';

const EARTH_RADIUS_KM = 6371;
const BASE_FARE = 2.5;
const RATE_PER_KM = 1.75;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

// Haversine formula: straight-line ("great-circle") distance between two
// lat/long points. A naive Pythagorean distance on raw degrees would be
// wrong because a degree of longitude covers less physical distance the
// further you are from the equator - Haversine accounts for that curvature.
export function distanceKm(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLong = toRadians(b.long - a.long);

  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLong / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

// Placeholder pricing model until a real mapping/pricing API is wired in:
// a flat base fare plus a per-km rate on straight-line distance.
export function estimateFare(source: Coordinates, destination: Coordinates): number {
  const distance = distanceKm(source, destination);
  const fare = BASE_FARE + distance * RATE_PER_KM;
  return Math.round(fare * 100) / 100;
}
