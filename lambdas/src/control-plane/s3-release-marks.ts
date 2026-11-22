import {
  GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand, NoSuchKey, type S3Client,
} from "@aws-sdk/client-s3";
import { ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import type { ArchiveMetadata } from "./backup-release.ts";
import { parsePresetCatalog } from "./preset-catalog.ts";
import {
  LEGACY_GENERATION, tableView, type ArchiveSource, type CatalogSource, type Listing, type ManifestSource, type MarkInput,
  type PointerSource, type SourceFailure, type TableItem, type TableView,
} from "./release-reconciler.ts";
import { legacyReleaseStateKey, parseLegacyReleaseState, parseReleaseState, releaseStateKey } from "./release-state.ts";
import { parseWorldRecord, type WorldRecord } from "./world-registry.ts";

// The reconciler's read adapters. Each port has list, get, head or scan methods
// and no other: the report-only run cannot change a bucket or the table.

export type ListedObject = Readonly<{ key: string; size: number }>;

export type ReleaseBucketReader = Readonly<{
  listKeys(prefix: string): Promise<readonly string[]>;
  /** Like listKeys, with each object's size: the sweep records it for an orphan. */
  listObjects(prefix: string): Promise<readonly ListedObject[]>;
  /** Null when the key does not exist. */
  getText(key: string): Promise<string | null>;
}>;

export type ArchiveVersion = Readonly<{ key: string; versionId: string }>;

export type BackupBucketReader = Readonly<{
  /** Every version of every key under the prefix, noncurrent ones included; delete markers are not versions. */
  listVersions(prefix: string): Promise<readonly ArchiveVersion[]>;
  /** One HEAD with the version id; null when that version does not exist. */
  head(key: string, versionId: string): Promise<ArchiveMetadata | null>;
}>;

export type RefsTableReader = Readonly<{ scan(): Promise<readonly TableItem[]> }>;

type S3Send = Pick<S3Client, "send">;

function missing(error: unknown): boolean {
  return error instanceof NoSuchKey || (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"));
}

export function s3ReleaseBucketReader(s3: S3Send, bucket: string): ReleaseBucketReader {
  const listObjects = async (prefix: string): Promise<ListedObject[]> => {
    const objects: ListedObject[] = [];
    let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ // NOSONAR paginated: the next token comes from the previous page
        Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}),
      }));
      for (const object of page.Contents ?? []) if (object.Key) objects.push({ key: object.Key, size: object.Size ?? 0 });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return objects;
  };
  return {
    listObjects,
    async listKeys(prefix) {
      return (await listObjects(prefix)).map((object) => object.key);
    },
    async getText(key) {
      try {
        const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = await response.Body?.transformToString();
        if (body === undefined) throw new Error("empty_body");
        return body;
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
  };
}

export function s3BackupBucketReader(s3: S3Send, bucket: string): BackupBucketReader {
  return {
    async listVersions(prefix) {
      const versions: ArchiveVersion[] = [];
      let keyMarker: string | undefined;
      let versionMarker: string | undefined;
      do {
        const page = await s3.send(new ListObjectVersionsCommand({ // NOSONAR paginated: the markers come from the previous page
          Bucket: bucket, Prefix: prefix,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}), ...(versionMarker ? { VersionIdMarker: versionMarker } : {}),
        }));
        for (const version of page.Versions ?? []) if (version.Key && version.VersionId) versions.push({ key: version.Key, versionId: version.VersionId });
        keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
      } while (keyMarker);
      return versions;
    },
    async head(key, versionId) {
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
        return {
          release: head.Metadata?.release ?? null,
          releaseSource: head.Metadata?.["release-source"] ?? null,
          storedAt: (head.LastModified ?? new Date(0)).toISOString(),
        };
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
  };
}

export function dynamoRefsTableReader(client: Pick<DynamoDBDocumentClient, "send">, table: string): RefsTableReader {
  return {
    async scan() {
      const items: TableItem[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const page = await client.send(new ScanCommand({ // NOSONAR paginated: the start key comes from the previous page
          TableName: table, ConsistentRead: true, ...(start ? { ExclusiveStartKey: start } : {}),
        }));
        items.push(...(page.Items ?? []));
        start = page.LastEvaluatedKey;
      } while (start);
      return items;
    },
  };
}

export type SourcePorts = Readonly<{ release: ReleaseBucketReader; backup: BackupBucketReader; table: RefsTableReader }>;

export type CollectedSources = Readonly<{ input: MarkInput; table: TableView | null; listing: Listing }>;

const ID = "[a-z0-9][a-z0-9-]{0,31}";
const MANIFEST_KEY = new RegExp(String.raw`^releases/(${ID})/(${ID})/(\d+\.\d+)/manifest\.json$`);
const WORLD_KEY = new RegExp(String.raw`^worlds/(${ID})/world\.json$`);
const CATALOG_KEY = new RegExp(String.raw`^presets/(${ID})/catalog\.json$`);
const ARCHIVE_KEY = new RegExp(String.raw`^worlds/(${ID})/archives/[A-Za-z0-9._-]+\.tar\.zst$`);
const CHUNK = 8;

// Only the error's name is kept: a failure line must not carry a body or a message.
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

async function inChunks<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += CHUNK) {
    results.push(...await Promise.all(items.slice(index, index + CHUNK).map(work))); // NOSONAR bounded chunks
  }
  return results;
}

/**
 * Reads every source. A failed read is recorded and the run goes on with what it could read.
 * `startedAt` is the run's start, taken by the caller before this call (the legacy pointer needs a date).
 */
export async function collectSources(ports: SourcePorts, startedAt: string): Promise<CollectedSources> {
  const failures: SourceFailure[] = [];
  const fail = (source: string, subject: string, error: unknown) => { failures.push({ source, subject, reason: typeof error === "string" ? error : reasonOf(error) }); };

  let table: TableView | null = null;
  try {
    table = tableView(await ports.table.scan());
  } catch (error) {
    fail("table", "release-refs", error);
  }
  let listing: Listing = null;
  try {
    const objects = await ports.release.listObjects("objects/sha256/");
    listing = { keys: objects.map((object) => object.key), sizes: new Map(objects.map((object) => [object.key, object.size])) };
  } catch (error) {
    fail("objects", "objects/sha256/", error);
  }

  const json = async (key: string): Promise<unknown> => {
    const text = await ports.release.getText(key);
    return text === null ? null : JSON.parse(text) as unknown;
  };

  let manifestsListed = true;
  const manifests: ManifestSource[] = [];
  try {
    const keys = (await ports.release.listKeys("releases/")).filter((key) => MANIFEST_KEY.test(key));
    for (const found of await inChunks(keys, async (key): Promise<ManifestSource | null> => {
      const match = MANIFEST_KEY.exec(key)!;
      try {
        const manifest = await json(key);
        if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("invalid_manifest");
        return { ref: { gameId: match[1]!, presetId: match[2]!, release: match[3]! }, manifest };
      } catch (error) {
        fail("manifest", key, error);
        return null;
      }
    })) if (found !== null) manifests.push(found);
  } catch (error) {
    manifestsListed = false;
    fail("manifests", "releases/", error);
  }

  const worlds: WorldRecord[] = [];
  const pointers: PointerSource[] = [];
  try {
    const keys = (await ports.release.listKeys("worlds/")).filter((key) => WORLD_KEY.test(key));
    await inChunks(keys, async (key) => {
      const worldId = WORLD_KEY.exec(key)![1]!;
      let record: WorldRecord | null = null;
      try {
        const value = await json(key);
        record = value === null ? null : parseWorldRecord(value);
        if (record?.worldId !== worldId) throw new Error("invalid_world_record");
      } catch (error) {
        fail("world", key, error);
        return;
      }
      const world: WorldRecord = record;
      worlds.push(world);
      // The pointer of a world from before generations. One that exists and cannot be parsed fails the run.
      const legacyKey = legacyReleaseStateKey(worldId);
      try {
        const value = await json(legacyKey);
        if (value !== null) {
          const state = parseLegacyReleaseState(value, { worldId, generationId: LEGACY_GENERATION }, startedAt);
          if (state === null) throw new Error("invalid_release_state");
          pointers.push({ worldId, state });
        }
      } catch (error) {
        fail("pointer", legacyKey, error);
      }
      for (const generation of [world.currentGeneration, ...world.previousGenerations]) {
        const ref = { worldId, generationId: generation.id };
        try {
          const value = await json(releaseStateKey(ref)); // NOSONAR a few generations per world
          if (value === null) continue;
          const state = parseReleaseState(value, ref);
          if (state === null) throw new Error("invalid_release_state");
          pointers.push({ worldId, state });
        } catch (error) {
          fail("pointer", releaseStateKey(ref), error);
        }
      }
    });
  } catch (error) {
    fail("worlds", "worlds/", error);
  }

  const catalogs: CatalogSource[] = [];
  try {
    const keys = (await ports.release.listKeys("presets/")).filter((key) => CATALOG_KEY.test(key));
    await inChunks(keys, async (key) => {
      const gameId = CATALOG_KEY.exec(key)![1]!;
      try {
        const value = await json(key);
        const presets = value === null ? null : parsePresetCatalog(value, gameId);
        if (presets === null) throw new Error("invalid_catalog");
        catalogs.push({ gameId, presets });
      } catch (error) {
        fail("catalog", key, error);
      }
    });
  } catch (error) {
    fail("catalogs", "presets/", error);
  }

  const archives: ArchiveSource[] = [];
  try {
    const versions = (await ports.backup.listVersions("worlds/")).filter((version) => ARCHIVE_KEY.test(version.key));
    await inChunks(versions, async (version) => {
      try {
        const metadata = await ports.backup.head(version.key, version.versionId);
        if (metadata !== null) archives.push({ worldId: ARCHIVE_KEY.exec(version.key)![1]!, key: version.key, versionId: version.versionId, metadata });
      } catch (error) {
        fail("archive", `${version.key}#${version.versionId}`, error);
      }
    });
  } catch (error) {
    fail("archives", "worlds/", error);
  }

  const retired = new Set<string>();
  for (const [id, item] of table?.releases ?? []) if (item.state === "retired") retired.add(id);
  const input: MarkInput = { manifestsListed, manifests, worlds, pointers, archives, catalogs, retired, failures };
  return { input, table, listing };
}
