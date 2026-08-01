import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

// scrypt is memory-hard (expensive to brute-force on GPUs/ASICs, unlike a
// plain SHA hash) and built into Node, so no extra dependency for something
// this security-sensitive. Each password gets its own random salt so two
// users with the same password don't produce the same stored hash.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  const storedKey = Buffer.from(hash, 'hex');

  // timingSafeEqual instead of `===` so a failed comparison always takes
  // the same time regardless of where the mismatch is - avoids leaking
  // information about the correct hash via response-time differences.
  return derivedKey.length === storedKey.length && timingSafeEqual(derivedKey, storedKey);
}
