import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { isSha256, manifestPackObject, objectKey, OBJECT_LAYOUT, type ManifestPack } from "../control-plane/release-objects.ts";
import { holderKey, type ClaimOptions, type FileClaim, type ObjectMode, type ReleaseRef, type ReleaseRefs } from "../control-plane/release-refs.ts";

// The builder's writer for the objects-v1 layout (ADR-0080, design 4.6). The
// core owns the order of steps and the rules; it builds no AWS client, so a
// test drives it with an in-memory port and table.
//
// Why one process with a worker pool: upload-release.sh starts one aws CLI
// process per object, 16 in flight, and reached only 1.9 objects/s on
// BUILD_GENERAL1_SMALL (2 vCPU, measured by the lead). A modpack has about 1,700
// objects, so this path uses one long-lived process and the AWS SDK.

export class WriterError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "WriterError";
    this.code = code;
  }
}

export type ObjectInfo = Readonly<{ bytes: number; checksumSha256: string | undefined }>;

/** The S3 calls the writer needs. `head` answers null for a missing key (404, or 403 for a role without ListBucket). */
export type ObjectPort = Readonly<{
  head: (key: string) => Promise<ObjectInfo | null>;
  /** A conditional write (If-None-Match: *); `exists` stands for 412. */
  put: (key: string, source: Readonly<{ path: string; bytes: number }>, checksumSha256: string) => Promise<Readonly<{ status: "created" | "exists"; checksumSha256: string | undefined }>>;
  /** A copy inside the bucket, also conditional. */
  copy: (sourceKey: string, key: string) => Promise<"created" | "exists">;
}>;

export type Manifest = Record<string, unknown> & {
  server?: { mods?: readonly Digested[]; overrides?: readonly (Digested & { path: string })[] };
  client?: { kind?: string; sha256?: string; mods?: readonly Digested[]; addons?: readonly Digested[] };
  packs?: Record<string, unknown>;
};
type Digested = Readonly<{ file?: string; sha256: string; bytes: number }>;

type Entry = { sha256: string; bytes: number; path: string; sources: string[]; checked: boolean; pack?: ManifestPack };

export type WriteResult = Readonly<{
  total: number;
  created: number;
  reused: number;
  recreated: number;
  /** Reused files whose object was missing and were uploaded from the local file. */
  repaired: number;
  copied: number;
  bytesUploaded: number;
  packs: Partial<Record<ManifestPack, Readonly<{ sha256: string; bytes: number }>>>;
}>;

export type WriteOptions = Readonly<{
  ref: ReleaseRef;
  buildId: string;
  profileDigest?: string;
  sourceDir: string;
  manifest: Manifest;
  /** Local zip of each pack. */
  packs: Partial<Record<ManifestPack, string>>;
  concurrency: number;
  /** sha256 to an `upstream/` key in the same bucket. */
  upstream?: ReadonlyMap<string, string>;
  /** The manifest is the one already published: verify its objects, recreate a missing one from a matching local file. */
  heal?: boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  waitMilliseconds?: number;
  progressEvery?: number;
  log?: (line: string) => void;
}>;

const base64 = (sha256: string) => Buffer.from(sha256, "hex").toString("base64");

export async function hashFile(path: string): Promise<Readonly<{ sha256: string; bytes: number }>> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** A sliding window: a lane takes the next item the moment it is free. The first failure stops queueing; running work finishes. */
export async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const lane = async () => {
    while (failure === undefined) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index]!); // NOSONAR one item at a time per lane: the pool bounds the concurrency
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure !== undefined) throw failure.error;
}

function digestOf(value: Digested | undefined, what: string): Digested {
  if (value === undefined || !isSha256(value.sha256) || !Number.isInteger(value.bytes) || value.bytes < 0) throw new WriterError("invalid_manifest", what);
  return value;
}

/** Every payload file of a manifest once per digest. A name-less sibling with the same digest adds a source, not an entry. */
export function manifestEntries(manifest: Manifest, sourceDir: string): Entry[] {
  const found = new Map<string, Entry>();
  const add = (value: Digested | undefined, path: string, sources: string[]) => {
    const { sha256, bytes } = digestOf(value, path);
    const known = found.get(sha256);
    if (known === undefined) found.set(sha256, { sha256, bytes, path, sources: sources.map((source) => join(sourceDir, source)), checked: false });
    else known.sources.push(...sources.map((source) => join(sourceDir, source)));
  };
  for (const mod of manifest.server?.mods ?? []) add(mod, `mods/${mod.file}`, [`mods/${mod.file}`]);
  for (const override of manifest.server?.overrides ?? []) add(override, `overrides/${override.path}`, [`overrides/${override.path}`]);
  // A players file is in client-mods/, or shares the server's file (ADR-0069).
  for (const mod of manifest.client?.mods ?? []) add(mod, `client-mods/${mod.file}`, [`client-mods/${mod.file}`, `mods/${mod.file}`]);
  for (const addon of manifest.client?.addons ?? []) add(addon, `client-mods/${addon.file}`, [`client-mods/${addon.file}`, `mods/${addon.file}`]);
  return [...found.values()];
}

/** A modpack names its client pack in `client`, inside the immutability gate. */
function clientPackInManifest(manifest: Manifest): boolean {
  return isSha256(manifest.client?.sha256);
}

/**
 * The manifest of an objects-v1 release. `client`, `server`, `loader` and
 * `runtime` stay as they are: they are inside the immutability gate.
 */
export function withObjectLayout(manifest: Manifest, packs: WriteResult["packs"]): Manifest {
  const entries: Record<string, { sha256: string; bytes: number }> = {};
  for (const name of PACKS) {
    const pack = packs[name];
    if (pack === undefined || (name === "client" && clientPackInManifest(manifest))) continue;
    entries[name] = { sha256: pack.sha256, bytes: pack.bytes };
  }
  const { storage: _storage, packs: _packs, ...rest } = manifest;
  const next = { ...rest, storage: { layout: OBJECT_LAYOUT }, ...(Object.keys(entries).length === 0 ? {} : { packs: entries }) };
  if (gateProjection(next) !== gateProjection(manifest)) throw new WriterError("manifest_gate_changed");
  return next;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => byCodeUnit(a, b)).map(([key, entry]) => [key, sorted(entry)]));
}

function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** What the immutability gate compares (`canonical_manifest` in upload-release.sh). */
export function gateProjection(manifest: Manifest): string {
  const { game, release, minecraft_version, loader, runtime, server, client } = manifest;
  return JSON.stringify(sorted({ game: game ?? "minecraft", release, minecraft_version, loader, runtime, server, client }));
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

const PACKS = ["client", "server", "full"] as const;

/** One pack zip: an entry hashed from the local file, or the stored one when only its object can be verified. Null means skip. */
async function packEntry(options: WriteOptions, name: (typeof PACKS)[number]): Promise<Entry | null> {
  const heal = options.heal === true;
  const path = options.packs[name];
  const stored = manifestPackObject(options.manifest, name);
  const modpack = name === "client" && clientPackInManifest(options.manifest);
  const label = modpack ? "client.zip" : `packs/${name}`;
  if (path === undefined) return heal && stored !== null ? { ...stored, path: label, sources: [], checked: true, pack: name } : null;
  if (!(await regularFile(path))) throw new WriterError("pack_missing", name);
  const actual = await hashFile(path);
  const expected = heal || modpack ? stored : null;
  if (expected !== null && (expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes)) {
    if (!heal) throw new WriterError("pack_mismatch", name);
    // A rebuilt zip may differ from the stored one: its object can be verified, not created.
    options.log?.(`pack ${name} differs from the manifest; its object is verified only`);
    return { ...expected, path: label, sources: [], checked: true, pack: name };
  }
  return { ...actual, path: label, sources: [path], checked: true, pack: name };
}

/** One entry for each local pack zip, hashed once; in heal mode also each pack the manifest names. */
async function packEntries(options: WriteOptions): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const name of PACKS) {
    const entry = await packEntry(options, name); // NOSONAR sequential: the first bad pack decides the error
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

export type WriterDeps = Readonly<{
  refs: Pick<ReleaseRefs, "beginBuild" | "claimFile">;
  port: ObjectPort;
}>;

/**
 * Steps of design 4.6: begin the build, then claim every distinct digest and
 * make sure its object exists. The reference is counted before the object is
 * written; an object that exists with other bytes fails the build, because
 * objects are immutable and a wrong one must never be replaced.
 */
export async function writeObjects(deps: WriterDeps, options: WriteOptions): Promise<WriteResult> {
  const { refs, port } = deps;
  const upstream = options.upstream ?? new Map<string, string>();
  const heal = options.heal === true;

  const packList = await packEntries(options);
  const packs: Partial<Record<ManifestPack, { sha256: string; bytes: number }>> = {};
  for (const entry of packList) if (entry.pack !== undefined) packs[entry.pack] = { sha256: entry.sha256, bytes: entry.bytes };
  // The modpack's client pack is in the manifest already; without --pack it is the payload's client.zip.
  if (clientPackInManifest(options.manifest) && !packList.some((entry) => entry.path === "client.zip")) {
    const stored = digestOf(options.manifest.client as Digested, "client");
    packList.push({ sha256: stored.sha256, bytes: stored.bytes, path: "client.zip", sources: [join(options.sourceDir, "client.zip")], checked: false });
  }
  // One entry for each digest; a pack equal to a payload file adds a source.
  const all = new Map<string, Entry>();
  for (const entry of [...manifestEntries(options.manifest, options.sourceDir), ...packList]) {
    const known = all.get(entry.sha256);
    if (known === undefined) all.set(entry.sha256, entry);
    else known.sources.push(...entry.sources);
  }

  const counts = { created: 0, reused: 0, recreated: 0, repaired: 0, copied: 0, bytesUploaded: 0 };

  const intact = (found: ObjectInfo | null, file: FileClaim): boolean => found !== null && found.bytes === file.bytes && found.checksumSha256 === base64(file.sha256);

  const confirm = (key: string, file: FileClaim, found: ObjectInfo | null): void => {
    if (found === null) throw new WriterError("object_missing", key);
    if (!intact(found, file)) throw new WriterError("object_mismatch", key);
  };

  const tryCopy = async (file: FileClaim, key: string): Promise<boolean> => {
    const from = upstream.get(file.sha256);
    if (!from?.startsWith("upstream/")) return false;
    try {
      // The source is checked first: a copy of wrong bytes would sit under an immutable key.
      const source = await port.head(from);
      if (!intact(source, file)) return false;
      const status = await port.copy(from, key);
      const copy = await port.head(key);
      if (!intact(copy, file)) return false;
      if (status === "created") counts.copied += 1;
      return true;
    } catch {
      return false;
    }
  };

  const upload = async (file: FileClaim, key: string, source: string | null): Promise<void> => {
    if (source === null) throw new WriterError("object_missing_no_source", key);
    const sum = base64(file.sha256);
    const put = await port.put(key, { path: source, bytes: file.bytes }, sum);
    if (put.status === "exists") {
      confirm(key, file, await port.head(key));
      return;
    }
    // S3 echoes the checksum only after it checked the bytes against the one we sent.
    if (put.checksumSha256 !== sum) throw new WriterError("object_not_confirmed", key);
    counts.bytesUploaded += file.bytes;
  };

  const ensure = async (file: FileClaim, mode: ObjectMode, source: string | null): Promise<void> => {
    const key = objectKey(file.sha256);
    if (mode === "verify") {
      const found = await port.head(key);
      if (found !== null) return confirm(key, file, found);
      // The reference was counted and the object never written: write it now.
      const before = counts.bytesUploaded;
      await upload(file, key, source);
      if (counts.bytesUploaded > before) counts.repaired += 1;
      return;
    }
    if (mode === "create" && (await tryCopy(file, key))) return;
    await upload(file, key, source);
  };

  await refs.beginBuild(options.ref, options.buildId, options.profileDigest);

  const started = Date.now();
  let done = 0;
  const work = [...all.values()];
  await runPool(work, options.concurrency, async (entry) => {
    const source = await localSource(entry, heal);
    const claim: ClaimOptions = {
      ensureObject: (file, mode) => ensure(file, mode, source),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.waitMilliseconds === undefined ? {} : { waitMilliseconds: options.waitMilliseconds }),
    };
    const outcome = await refs.claimFile(options.ref, { sha256: entry.sha256, bytes: entry.bytes, path: entry.path }, claim);
    counts[outcome] += 1;
    done += 1;
    if (options.progressEvery !== undefined && done % options.progressEvery === 0) options.log?.(`claimed ${done} objects in ${Math.round((Date.now() - started) / 1000)}s`);
  });

  return { total: work.length, ...counts, packs };
}

/** The first regular local file of an entry, checked against its digest. Null only in heal mode. */
async function localSource(entry: Entry, heal: boolean): Promise<string | null> {
  let source: string | null = null;
  for (const candidate of entry.sources) {
    if (await regularFile(candidate)) { // NOSONAR in order: the first regular file wins
      source = candidate;
      break;
    }
  }
  if (source === null) {
    if (!heal) throw new WriterError("local_file_missing", entry.path);
    return null;
  }
  if (!entry.checked) {
    const actual = await hashFile(source);
    if (actual.bytes !== entry.bytes) throw new WriterError("local_size_mismatch", entry.path);
    if (actual.sha256 !== entry.sha256) throw new WriterError("local_digest_mismatch", entry.path);
  }
  return source;
}

/** The manifest is written: live first (a holder needs a live release), then the catalog holder, then the build holder goes. Safe to repeat. */
export async function publishRelease(refs: Pick<ReleaseRefs, "publish" | "hold" | "dropHolder">, ref: ReleaseRef, buildId: string): Promise<void> {
  await refs.publish(ref);
  await refs.hold(ref, holderKey.catalog(ref.gameId), ["catalog"]);
  await refs.dropHolder(ref, holderKey.build(buildId));
}

/** The catalog is about to list these releases: hold them first, so no retirement can take one from under it. */
export async function holdCatalog(refs: Pick<ReleaseRefs, "hold">, gameId: string, presetId: string, releases: readonly string[]): Promise<void> {
  for (const release of releases) await refs.hold({ gameId, presetId, release }, holderKey.catalog(gameId), ["catalog"]); // NOSONAR sequential: a refusal must stop the next hold
}
