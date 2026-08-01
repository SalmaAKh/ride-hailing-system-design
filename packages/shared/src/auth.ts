import jwt from 'jsonwebtoken';
import type { UserRole } from './types';

// Local-dev-only default so every service signs/verifies with the same
// secret without extra setup. Never rely on this default outside a local
// learning environment - override via JWT_SECRET for anything real.
const JWT_SECRET = process.env.JWT_SECRET ?? 'local-dev-secret-do-not-use-in-prod';

const TOKEN_TTL = '7d';

export interface AuthTokenPayload {
  userId: string;
  profileId: string;
  role: UserRole;
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}
