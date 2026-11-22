import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import type { MarkInput } from "./release-reconciler.ts";
import { releaseManifestKey } from "./release-artifacts.ts";
import type { CatalogStore, RetirementDeps } from "./release-retirement.ts";
import { collectSources, type BackupBucketReader, type ReleaseBucketReader } from "./s3-release-marks.ts";

// The retirement's S3 ports. The only write is the preset catalog, under
// `If-Match`. Nothing here can delete or touch an object of `objects/`.

type S3Send = Pick<S3Client, "send">;

const CATALOG_KEY = (gameId: string) => `presets/${gameId}/catalog.json`;

function absent(error: unknown): boolean {
  return error instanceof NoSuchKey || (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"));
}

/** A lost `If-Match` race is 412, or 409 while another write to the key is in flight. */
function raceLost(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  return name === "PreconditionFailed" || name === "ConditionalRequestConflict" || status === 412 || status === 409;
}

export function s3CatalogStore(s3: S3Send, bucket: string): CatalogStore {
  return {
    async read(gameId) {
      try {
        const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: CATALOG_KEY(gameId) }));
        const text = await response.Body?.transformToString();
        if (text === undefined || !response.ETag) throw new Error("empty_catalog");
        return { document: JSON.parse(text) as unknown, etag: response.ETag };
      } catch (error) {
        if (absent(error)) return null;
        throw error;
      }
    },
    async write(gameId, document, etag) {
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: CATALOG_KEY(gameId), IfMatch: etag,
          Body: `${JSON.stringify(document, null, 2)}\n`, ContentType: "application/json",
        }));
        return "written";
      } catch (error) {
        if (raceLost(error)) return "lost";
        throw error;
      }
    },
  };
}

export async function readReleaseManifest(reader: Pick<ReleaseBucketReader, "getText">, ref: Readonly<{ gameId: string; presetId: string; release: string }>): Promise<unknown | null> {
  const text = await reader.getText(releaseManifestKey(ref.gameId, ref.presetId, ref.release));
  return text === null ? null : JSON.parse(text) as unknown;
}

/**
 * The live check needs worlds, pointers, archives and catalogs. It does not
 * need the `objects/` listing, the other manifests or the table, so those reads
 * return nothing: the role has no right to list `objects/` or `releases/`.
 */
export function liveSourceReader(
  ports: Readonly<{ release: ReleaseBucketReader; backup: BackupBucketReader }>,
  now: () => Date,
): () => Promise<MarkInput> {
  const none = async () => [] as never[];
  const release: ReleaseBucketReader = {
    ...ports.release,
    listKeys: (prefix) => (prefix.startsWith("worlds/") || prefix.startsWith("presets/") ? ports.release.listKeys(prefix) : none()),
    listObjects: async (prefix) => (prefix.startsWith("worlds/") || prefix.startsWith("presets/") ? ports.release.listObjects(prefix) : none()),
  };
  return async () => (await collectSources({ release, backup: ports.backup, table: { scan: none } }, now().toISOString())).input;
}

export function retirementPorts(
  s3: S3Send,
  ports: Readonly<{ release: ReleaseBucketReader; backup: BackupBucketReader }>,
  releaseBucket: string,
  now: () => Date,
): Pick<RetirementDeps, "readManifest" | "readSources" | "catalogs" | "now"> {
  return {
    readManifest: (ref) => readReleaseManifest(ports.release, ref),
    readSources: liveSourceReader(ports, now),
    catalogs: s3CatalogStore(s3, releaseBucket),
    now,
  };
}
