import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Length is the one rule. Composition rules push people towards predictable
// substitutions and are recommended by neither NCSC nor NIST; a long
// passphrase is. The ceiling stops a hash of arbitrary size.
export const passwordMinimumLength = 12;
export const passwordMaximumLength = 128;
export const displayNameMaximumLength = 80;

// Ten wrong guesses lock an address for fifteen minutes. Online guessing is
// the realistic attack on a small private deployment; this bounds it to under
// a thousand guesses a day per address without locking anybody out for long
// after a typo.
export const failedSignInsBeforeLock = 10;
export const signInLockSeconds = 15 * 60;

// scrypt with N=2^15, r=8, p=1 needs 32 MiB and tens of milliseconds on the
// 256 MB Lambda. The parameters are stored beside each hash, so raising them
// later is a new hash on the next successful sign-in, not a migration.
const scryptParameters = { cost: 2 ** 15, blockSize: 8, parallelism: 1 } as const;
const scryptKeyLength = 32;
const scryptSaltBytes = 16;
const scryptCostCeiling = 2 ** 20;

export type PasswordProblem = "not_a_string" | "too_short" | "too_long";

export type SignInGuard = Readonly<{
  failedSignIns: number;
  lockedUntilEpochSeconds: number | null;
}>;

export const openGuard: SignInGuard = { failedSignIns: 0, lockedUntilEpochSeconds: null };

// The address is the sign-in name, so two spellings of one mailbox must not
// become two accounts: trimmed, lower-cased, one @, a dotted domain, nothing
// that is not printable.
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@")) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!/^[^\s@\p{C}]{1,64}$/u.test(local)) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) return null;
  return email;
}

export function validatePassword(value: unknown): PasswordProblem | null {
  if (typeof value !== "string") return "not_a_string";
  if (value.length < passwordMinimumLength) return "too_short";
  if (value.length > passwordMaximumLength) return "too_long";
  return null;
}

export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= displayNameMaximumLength ? name : null;
}

type ScryptParameters = Readonly<{ cost: number; blockSize: number; parallelism: number }>;

function derive(password: string, salt: Buffer, parameters: ScryptParameters, keyLength: number): Promise<Buffer> {
  // NFKC, so one passphrase typed through two keyboards is one passphrase.
  const normalized = password.normalize("NFKC");
  const options = {
    N: parameters.cost,
    r: parameters.blockSize,
    p: parameters.parallelism,
    maxmem: 256 * parameters.cost * parameters.blockSize,
  };
  return new Promise((resolve, reject) => {
    scrypt(normalized, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

// "scrypt$N$r$p$salt$key", the binary parts base64url. Self-describing, so a
// credential verifies with the parameters it was hashed with.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(scryptSaltBytes);
  const key = await derive(password, salt, scryptParameters, scryptKeyLength);
  return [
    "scrypt", scryptParameters.cost, scryptParameters.blockSize, scryptParameters.parallelism,
    salt.toString("base64url"), key.toString("base64url"),
  ].join("$");
}

type StoredHash = Readonly<{ parameters: ScryptParameters; salt: Buffer; key: Buffer }>;

function positiveInteger(value: string | undefined, ceiling: number): number | null {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= ceiling ? parsed : null;
}

function parseStoredHash(stored: string): StoredHash | null {
  const [scheme, cost, blockSize, parallelism, salt, key, extra] = stored.split("$");
  if (scheme !== "scrypt" || extra !== undefined || salt === undefined || key === undefined) return null;
  const parameters = {
    cost: positiveInteger(cost, scryptCostCeiling),
    blockSize: positiveInteger(blockSize, 64),
    parallelism: positiveInteger(parallelism, 16),
  };
  if (parameters.cost === null || parameters.blockSize === null || parameters.parallelism === null) return null;
  if ((parameters.cost & (parameters.cost - 1)) !== 0) return null;
  const saltBytes = Buffer.from(salt, "base64url");
  const keyBytes = Buffer.from(key, "base64url");
  if (saltBytes.length < 8 || keyBytes.length < 16) return null;
  return {
    parameters: { cost: parameters.cost, blockSize: parameters.blockSize, parallelism: parameters.parallelism },
    salt: saltBytes,
    key: keyBytes,
  };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (parsed === null) return false;
  const key = await derive(password, parsed.salt, parsed.parameters, parsed.key.length);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

export function signInLocked(guard: SignInGuard, nowSeconds: number): boolean {
  return guard.lockedUntilEpochSeconds !== null && guard.lockedUntilEpochSeconds > nowSeconds;
}

// A lock that has run out has been paid for: the count starts again rather
// than locking on the very next wrong guess.
export function afterFailedSignIn(guard: SignInGuard, nowSeconds: number): SignInGuard {
  const expired = guard.lockedUntilEpochSeconds !== null && guard.lockedUntilEpochSeconds <= nowSeconds;
  const failedSignIns = (expired ? 0 : guard.failedSignIns) + 1;
  return {
    failedSignIns,
    lockedUntilEpochSeconds: failedSignIns >= failedSignInsBeforeLock ? nowSeconds + signInLockSeconds : null,
  };
}
