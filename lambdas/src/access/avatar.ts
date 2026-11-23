import { createHash } from "node:crypto";

// What an identity avatar may be (ADR-0084). No I/O here.

export type AvatarType = "jpg" | "png" | "webp";

/** The most a provider photo may weigh when it is copied. */
export const PROVIDER_PHOTO_LIMIT = 512 * 1024;
/** The most a person may upload; the panel sends a 256 × 256 image well under it. */
export const UPLOAD_LIMIT = 256 * 1024;

export const CONTENT_TYPE: Readonly<Record<AvatarType, string>> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** The image type by its first bytes, or null for anything else. */
export function imageType(bytes: Uint8Array): AvatarType | null {
  const at = (index: number) => bytes[index];
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpg";
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => at(index) === value)) return "png";
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "webp";
  return null;
}

/** Content-addressed, under the identity's own prefix, so deleting the prefix deletes every picture it had. */
export function avatarKey(identityId: string, bytes: Uint8Array, type: AvatarType): string {
  return `${identityPrefix(identityId)}${createHash("sha256").update(bytes).digest("hex")}.${type}`;
}

export const identityPrefix = (identityId: string): string => `${identityId}/`;

// The hosts that serve the pictures Telegram and Google sign into their login data.
const PHOTO_HOSTS = [/^t\.me$/, /^([a-z0-9-]+\.)*telegram\.org$/, /^([a-z0-9-]+\.)*telesco\.pe$/, /^([a-z0-9-]+\.)*googleusercontent\.com$/];

/** Whether a provider photo address may be fetched: https, on a provider's picture host. */
export function fetchablePhoto(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === "https:" && parsed.username === "" && parsed.port === ""
    && PHOTO_HOSTS.some((host) => host.test(parsed.hostname));
}

/** Where an avatar came from: the provider a sign-in copied it from, or the person. */
export type AvatarSource = "telegram" | "google" | "upload";

export function providerSource(provider: string): AvatarSource | null {
  return provider === "telegram" || provider === "google" ? provider : null;
}

type AccountItem = Readonly<Record<string, unknown>>;

/**
 * The photo to copy for an identity, from its accounts: the signed-in
 * account's, else the Telegram account's, else any linked account's. Only an
 * https address on a provider's picture host counts.
 */
export function providerPhoto(
  accounts: readonly AccountItem[], signedIn?: Readonly<{ provider: string; subject: string }>,
): Readonly<{ url: string; provider: string }> | null {
  const own = signedIn === undefined ? undefined
    : accounts.find((account) => account.platform === signedIn.provider && account.platform_user_id === signedIn.subject);
  const ordered = [...(own === undefined ? [] : [own]), ...accounts.filter((account) => account.platform === "telegram"), ...accounts];
  for (const account of ordered) {
    const url = account.photo_url;
    if (typeof url === "string" && typeof account.platform === "string" && providerSource(account.platform) !== null && fetchablePhoto(url)) {
      return { url, provider: account.platform };
    }
  }
  return null;
}
