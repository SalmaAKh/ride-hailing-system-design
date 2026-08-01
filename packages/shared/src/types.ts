// ---- Shared value types ----

export interface Coordinates {
  lat: number;
  long: number;
}

export interface PaymentMethod {
  id: string;
  type: 'card' | 'paypal' | 'apple_pay' | 'google_pay';
  last4?: string;
  isDefault: boolean;
}

// ---- Core entities (persisted in DynamoDB) ----

export interface Rider {
  id: string;
  name: string;
  email: string;
  phone: string;
  paymentMethods: PaymentMethod[];
  createdAt: string; // ISO timestamp
}

export type DriverStatus = 'available' | 'in_ride' | 'offline';

export interface Vehicle {
  make: string;
  model: string;
  year: number;
  plate: string;
}

export interface Driver {
  id: string;
  name: string;
  email: string;
  phone: string;
  vehicle: Vehicle;
  status: DriverStatus;
  createdAt: string; // ISO timestamp
}

export type RideStatus =
  | 'fare_estimated' // fare-estimate created, no ride requested yet
  | 'requested' // rider confirmed, waiting on matching
  | 'matched' // driver accepted
  | 'picked_up'
  | 'dropped_off'
  | 'completed'
  | 'cancelled';

export interface Ride {
  id: string;
  riderId: string;
  driverId?: string;
  source: Coordinates;
  destination: Coordinates;
  fare: number;
  eta?: number; // seconds
  status: RideStatus;
  requestedAt?: string;
  matchedAt?: string;
  pickedUpAt?: string;
  droppedOffAt?: string;
  createdAt: string;
}

// ---- Ephemeral / real-time data (lives in Redis, NOT DynamoDB) ----
// Kept here too since services on both sides of the wire need the shape.

export interface DriverLocation extends Coordinates {
  driverId: string;
  updatedAt: string;
}

export interface DriverLock {
  driverId: string;
  rideId: string;
  ttlSeconds: number;
}
