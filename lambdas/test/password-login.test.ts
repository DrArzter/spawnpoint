import assert from "node:assert/strict";
import test from "node:test";

import {
  afterFailedSignIn,
  failedSignInsBeforeLock,
  hashPassword,
  normalizeDisplayName,
  normalizeEmail,
  openGuard,
  passwordMaximumLength,
  passwordMinimumLength,
  signInLocked,
  signInLockSeconds,
  validatePassword,
  verifyPassword,
} from "../src/access/password-credential.ts";
import {
  createPasswordLoginProvider,
  passwordPrincipal,
  type PasswordCredential,
  type PasswordCredentialStore,
} from "../src/access/password-login-provider.ts";

const now = 1_800_000_000;

test("an email is one spelling of one mailbox", () => {
  assert.equal(normalizeEmail("  Ada.Lovelace@Example.COM "), "ada.lovelace@example.com");
  assert.equal(normalizeEmail("ada+games@sub.example.co.uk"), "ada+games@sub.example.co.uk");
  for (const rejected of ["ada", "ada@", "@example.com", "ada@@example.com", "ada@example", "ada lovelace@example.com", "ada@-example.com", 42, null, `${"a".repeat(250)}@example.com`]) {
    assert.equal(normalizeEmail(rejected), null, `${String(rejected)} should be rejected`);
  }
});

test("a password is judged by length alone", () => {
  assert.equal(validatePassword("a".repeat(passwordMinimumLength - 1)), "too_short");
  assert.equal(validatePassword("a".repeat(passwordMinimumLength)), null);
  assert.equal(validatePassword("a".repeat(passwordMaximumLength + 1)), "too_long");
  assert.equal(validatePassword(12345678901234), "not_a_string");
  assert.equal(validatePassword("correct horse battery staple"), null, "no composition rule");
});

test("a display name is trimmed, collapsed and bounded", () => {
  assert.equal(normalizeDisplayName("  Ada   Lovelace "), "Ada Lovelace");
  assert.equal(normalizeDisplayName("   "), null);
  assert.equal(normalizeDisplayName("a".repeat(81)), null);
  assert.equal(normalizeDisplayName(7), null);
});

test("a hash verifies its own password and nothing else", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.match(stored, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("correct horse battery stapler", stored), false);
  assert.equal(await verifyPassword("correct horse battery staple", `${stored}x`), false);
  assert.equal(await verifyPassword("correct horse battery staple", "bcrypt$nonsense"), false);
  assert.equal(await verifyPassword("correct horse battery staple", ""), false);
});

test("two hashes of one password differ by salt and both verify", async () => {
  const [first, second] = await Promise.all([hashPassword("correct horse battery staple"), hashPassword("correct horse battery staple")]);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("correct horse battery staple", second), true);
});

test("a passphrase typed through two keyboards is one passphrase", async () => {
  // Å as one code point, and as A followed by a combining ring above.
  const stored = await hashPassword("Ångström passphrase");
  assert.equal(await verifyPassword("Ångström passphrase", stored), true);
});

test("a hash whose parameters would exhaust memory is refused, not derived", async () => {
  const stored = await hashPassword("correct horse battery staple");
  const oversized = stored.replace("$32768$", `$${2 ** 21}$`);
  assert.equal(await verifyPassword("correct horse battery staple", oversized), false);
  const notPowerOfTwo = stored.replace("$32768$", "$30000$");
  assert.equal(await verifyPassword("correct horse battery staple", notPowerOfTwo), false);
});

test("ten wrong guesses lock an address for fifteen minutes, then the count starts again", () => {
  let guard = openGuard;
  for (let attempt = 1; attempt < failedSignInsBeforeLock; attempt += 1) {
    guard = afterFailedSignIn(guard, now);
    assert.equal(guard.failedSignIns, attempt);
    assert.equal(signInLocked(guard, now), false);
  }
  guard = afterFailedSignIn(guard, now);
  assert.equal(guard.failedSignIns, failedSignInsBeforeLock);
  assert.equal(guard.lockedUntilEpochSeconds, now + signInLockSeconds);
  assert.equal(signInLocked(guard, now + signInLockSeconds - 1), true);
  assert.equal(signInLocked(guard, now + signInLockSeconds), false);

  const afterExpiry = afterFailedSignIn(guard, now + signInLockSeconds);
  assert.deepEqual(afterExpiry, { failedSignIns: 1, lockedUntilEpochSeconds: null });
});

type Recorded = { failures: Array<{ email: string; guard: typeof openGuard }>; successes: string[]; lookups: string[] };

function storeWith(credentials: readonly PasswordCredential[]): PasswordCredentialStore & { recorded: Recorded } {
  const recorded: Recorded = { failures: [], successes: [], lookups: [] };
  return {
    recorded,
    async find(email) {
      recorded.lookups.push(email);
      return credentials.find((credential) => credential.email === email) ?? null;
    },
    async recordFailure(email, guard, attemptedAt) {
      recorded.failures.push({ email, guard: afterFailedSignIn(guard, attemptedAt) });
    },
    async recordSuccess(email) { recorded.successes.push(email); },
  };
}

test("the provider signs in a registered address with its password and nothing weaker", async () => {
  const passwordHash = await hashPassword("correct horse battery staple");
  const credential: PasswordCredential = { subject: "3f1b4a3e-6f5d-4b6a-9d0e-1c2b3a4d5e6f", email: "ada@example.com", emailVerified: true, displayName: "Ada", passwordHash, guard: openGuard };
  const store = storeWith([credential]);
  const provider = createPasswordLoginProvider({ credentials: store, nowSeconds: () => now });

  assert.deepEqual(await provider.authenticate({ email: " Ada@Example.com", password: "correct horse battery staple" }), {
    provider: "password",
    subject: credential.subject,
    displayName: "Ada",
    username: null,
    photoUrl: null,
    email: "ada@example.com",
  });
  assert.deepEqual(store.recorded.successes, [], "a clean guard is not rewritten on every sign-in");

  assert.equal(await provider.authenticate({ email: "ada@example.com", password: "correct horse battery stapler" }), null);
  assert.deepEqual(store.recorded.failures, [{ email: "ada@example.com", guard: { failedSignIns: 1, lockedUntilEpochSeconds: null } }]);

  assert.equal(await provider.authenticate({ email: "nobody@example.com", password: "correct horse battery staple" }), null);
  assert.equal(await provider.authenticate({ email: "not an email", password: "correct horse battery staple" }), null);
  assert.equal(await provider.authenticate({ email: "ada@example.com", password: 42 }), null);
  assert.equal(await provider.authenticate({ email: "ada@example.com", password: "" }), null);
  assert.deepEqual(store.recorded.lookups, ["ada@example.com", "ada@example.com", "nobody@example.com"], "malformed attempts never reach the store");
});

test("a locked credential refuses even the right password, and a success after failures clears the count", async () => {
  const passwordHash = await hashPassword("correct horse battery staple");
  const locked: PasswordCredential = {
    subject: "s-locked", email: "locked@example.com", emailVerified: true, displayName: "Locked", passwordHash,
    guard: { failedSignIns: failedSignInsBeforeLock, lockedUntilEpochSeconds: now + 60 },
  };
  const bruised: PasswordCredential = {
    subject: "s-bruised", email: "bruised@example.com", emailVerified: true, displayName: "Bruised", passwordHash,
    guard: { failedSignIns: 3, lockedUntilEpochSeconds: null },
  };
  const store = storeWith([locked, bruised]);
  const provider = createPasswordLoginProvider({ credentials: store, nowSeconds: () => now });

  assert.equal(await provider.authenticate({ email: "locked@example.com", password: "correct horse battery staple" }), null);
  assert.deepEqual(store.recorded.failures, [], "a locked address is not counted against again");

  const principal = await provider.authenticate({ email: "bruised@example.com", password: "correct horse battery staple" });
  assert.equal(principal?.subject, "s-bruised");
  assert.deepEqual(store.recorded.successes, ["bruised@example.com"]);
});

test("an unverified address cannot sign in even with its correct password", async () => {
  const passwordHash = await hashPassword("correct horse battery staple");
  const credential: PasswordCredential = {
    subject: "s-pending", email: "pending@example.com", emailVerified: false,
    displayName: "Pending", passwordHash, guard: openGuard,
  };
  const store = storeWith([credential]);
  const provider = createPasswordLoginProvider({ credentials: store, nowSeconds: () => now });
  assert.equal(await provider.authenticate({ email: credential.email, password: "correct horse battery staple" }), null);
  assert.deepEqual(store.recorded.failures, [], "verification state is not a failed password guess");
});

test("the principal names the credential, not the address, as its subject", () => {
  assert.deepEqual(passwordPrincipal({ subject: "s-1", email: "ada@example.com", displayName: "Ada" }), {
    provider: "password", subject: "s-1", displayName: "Ada", username: null, photoUrl: null, email: "ada@example.com",
  });
});
