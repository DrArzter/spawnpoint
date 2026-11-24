import { DeleteObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";

import type { ArchiveObject, RetentionStore } from "./backup-retention.ts";
import { S3ReleaseStateReader } from "./s3-release-state-store.ts";
import type { S3WorldReader } from "./s3-world-repository.ts";

type S3Send = Pick<S3Client, "send">;

const WORLD_PREFIX = /^worlds\/([a-z0-9][a-z0-9-]{0,31})\/$/;

export function s3RetentionStore(
  s3: S3Send, backupBucket: string, worlds: Pick<S3WorldReader, "read">, releaseBucket?: string,
): RetentionStore {
  const states = releaseBucket === undefined ? null : new S3ReleaseStateReader(s3 as S3Client, releaseBucket);
  return {
    async listWorldIds() {
      const ids: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ // NOSONAR paginated: the next token comes from the previous page
          Bucket: backupBucket, Prefix: "worlds/", Delimiter: "/", ...(token ? { ContinuationToken: token } : {}),
        }));
        for (const prefix of page.CommonPrefixes ?? []) {
          const id = prefix.Prefix?.match(WORLD_PREFIX)?.[1];
          if (id !== undefined) ids.push(id);
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return ids;
    },
    async listArchives(worldId) {
      const objects: ArchiveObject[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ // NOSONAR paginated: the next token comes from the previous page
          Bucket: backupBucket, Prefix: `worlds/${worldId}/archives/`, ...(token ? { ContinuationToken: token } : {}),
        }));
        for (const object of page.Contents ?? []) {
          if (!object.Key || !object.LastModified) continue;
          objects.push({
            key: object.Key, sizeBytes: object.Size ?? 0, storedAt: object.LastModified.toISOString(),
            checksumAlgorithms: object.ChecksumAlgorithm ?? [],
          });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },
    async readWorld(worldId) {
      return (await worlds.read(worldId))?.record ?? null;
    },
    async readPrePromotionBackups(record) {
      if (states === null) return [];
      const keys: string[] = [];
      // A pointer that cannot be read fails this world's run, so nothing of it is removed.
      for (const generation of [record.currentGeneration, ...record.previousGenerations]) {
        const stored = await states.read({ worldId: record.worldId, generationId: generation.id }); // NOSONAR few wipes per world
        if (stored?.state.prePromotionBackup) keys.push(stored.state.prePromotionBackup.key);
      }
      return keys;
    },
    async deleteArchive(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: backupBucket, Key: key }));
    },
  };
}

