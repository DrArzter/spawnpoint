// The content-addressed layout of ADR-0080: payload files and packs are objects
// named by their SHA-256, and a manifest refers to them by digest.

import { releasePackKey } from "./release-artifacts.ts";

const SHA256 = /^[0-9a-f]{64}$/;

export const OBJECT_LAYOUT = "objects-v1";

/** The reference table's own name; Terraform and the Lambdas agree on it by test. */
export const RELEASE_REFS_TABLE_DEFAULT = "spawnpoint-release-refs";

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

/** Where the bytes with this digest live: no file name, no extension. */
export function objectKey(sha256: string): string {
  if (!isSha256(sha256)) throw new Error("invalid_digest");
  return `objects/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

/** The digest an `objects/` key names, or null when the key is not an object key. */
export function digestOfObjectKey(key: string): string | null {
  const match = /^objects\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(key);
  return match?.[2]?.startsWith(match[1]!) ? match[2]! : null;
}

/** A manifest without `storage.layout = objects-v1` is legacy: its readers use per-release keys. */
export function manifestUsesObjects(manifest: unknown): boolean {
  return (manifest as { storage?: { layout?: unknown } } | null)?.storage?.layout === OBJECT_LAYOUT;
}

export type ManifestPack = "client" | "server" | "full";

/**
 * The digest and size of one pack of an objects-v1 manifest; null when the
 * release has none. A modpack release names its client pack in `client`
 * (inside the immutability gate); every other pack is in `packs`, outside it.
 */
export function manifestPackObject(manifest: unknown, pack: ManifestPack): Readonly<{ sha256: string; bytes: number }> | null {
  type Entry = { sha256?: unknown; bytes?: unknown } | undefined;
  const root = manifest as { client?: Entry; packs?: Record<string, Entry> } | null;
  const entry = pack === "client" && isSha256(root?.client?.sha256) ? root?.client : root?.packs?.[pack];
  if (!isSha256(entry?.sha256)) return null;
  return { sha256: entry.sha256, bytes: typeof entry.bytes === "number" ? entry.bytes : 0 };
}

/**
 * Where one pack of a release is stored, for either layout: the object of its
 * digest in an objects-v1 release, its own key in a legacy one. Null when an
 * objects-v1 manifest names no such pack.
 */
export function releasePackStorageKey(manifest: unknown, gameId: string, presetId: string, release: string, pack: ManifestPack): string | null {
  if (!manifestUsesObjects(manifest)) return releasePackKey(gameId, presetId, release, pack);
  const object = manifestPackObject(manifest, pack);
  return object === null ? null : objectKey(object.sha256);
}

// Reference table keys (infra/terraform-storage, ADR-0080). pk and sk, as in the
// control-plane view table.
export function releaseItemPk(gameId: string, presetId: string, release: string): string {
  return `release#${gameId}/${presetId}/${release}`;
}

export function fileItemPk(sha256: string): string {
  if (!isSha256(sha256)) throw new Error("invalid_digest");
  return `file#${sha256}`;
}

export const ITEM_META_SK = "meta";

export type ReleaseLayout = "legacy" | "objects";
export type ReleaseItemState = "building" | "live" | "retiring" | "retired";
export type FileItemState = "live" | "condemned" | "deleting" | "deleted";

export const RELEASE_ITEM_STATES: readonly ReleaseItemState[] = ["building", "live", "retiring", "retired"];
