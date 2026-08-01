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
  userId: string; // -> User.id, the source of truth for name/email/phone/credentials
  paymentMethods: PaymentMethod[];
  createdAt: string; // ISO timestamp - when this rider profile was created
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
  userId: string; // -> User.id, the source of truth for name/email/phone/credentials
  vehicle: Vehicle;
  status: DriverStatus;
  createdAt: string; // ISO timestamp - when this driver profile was created
}

// ---- Auth ----

export type UserRole = 'rider' | 'driver';

export interface User {
  id: string;
  email: string;
  name: string;
  phone: string;
  passwordHash: string;
  role: UserRole;
  profileId: string; // Rider.id or Driver.id, depending on role
  createdAt: string; // when the account itself was created
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
