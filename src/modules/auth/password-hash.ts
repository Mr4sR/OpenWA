import { randomBytes, scrypt, timingSafeEqual } from 'crypto';

/**
 * Password hashing for SaaS logins: scrypt with a per-password salt, stored as a single
 * self-describing string so the cost parameters travel with the hash:
 *
 *   `scrypt$<N>$<r>$<p>$<salt-base64>$<hash-base64>`
 *
 * scrypt is memory-hard (unlike a bare PBKDF2/SHA loop) and ships in Node core, so a deployment
 * needs no native module. Verification is constant-time (`timingSafeEqual`) and re-derives with the
 * parameters RECORDED IN THE ROW, so raising the defaults later does not lock anyone out.
 *
 * Cost defaults: N=16384, r=8, p=1 (≈16 MiB per verification — OWASP's floor for scrypt).
 */
export const SCRYPT_N = 16_384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** Node's default maxmem (32 MiB) is too small for N=16384,r=8 on some builds. */
const MAX_MEM = 64 * 1024 * 1024;

/** A short floor that every caller shares; the DTO also enforces it, this is defense-in-depth. */
export const PASSWORD_MIN_LENGTH = 8;
/** A password longer than this is a paste accident, not a secret worth hashing. */
export const PASSWORD_MAX_LENGTH = 200;

// ES2023 target: Promise.withResolvers() is ES2024, so the executor form stays.
const derive = (password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N: n, r, p, maxmem: MAX_MEM }, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });

/** Hash a password for storage. Throws on an empty/oversized value (never stores a blank secret). */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Verify a password against a stored hash. Returns false — never throws — for a null/blank/
 * malformed stored value, so a corrupt row fails closed at the login form instead of 500ing it.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored || typeof password !== 'string' || password.length === 0) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await derive(password, salt, n, r, p);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    // An out-of-range cost parameter (a hand-edited row) makes scrypt throw; treat as no match.
    return false;
  }
}

/** True when a stored value uses older cost parameters than the current defaults. */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored) return true;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return (
    Number.parseInt(parts[1], 10) !== SCRYPT_N ||
    Number.parseInt(parts[2], 10) !== SCRYPT_R ||
    Number.parseInt(parts[3], 10) !== SCRYPT_P
  );
}
