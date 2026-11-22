import { HeadObjectCommand, NoSuchKey, type S3Client } from "@aws-sdk/client-s3";

import type { BackupReleaseSources } from "./backup-release.ts";
import { S3ReleaseStateStore } from "./s3-release-state-store.ts";

function missing(error: unknown): boolean {
  return error instanceof NoSuchKey || (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"));
}

/** Reads an archive's metadata with one HEAD, never its body, and the source wipe's pointer without migrating it. */
export function s3BackupReleaseSources(s3: Pick<S3Client, "send">, backupBucket: string, releaseBucket: string): BackupReleaseSources {
  const states = new S3ReleaseStateStore(s3 as S3Client, releaseBucket);
  return {
    async readArchiveMetadata(key) {
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: backupBucket, Key: key }));
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
    async readReleaseState(ref) {
      return (await states.read(ref))?.state ?? null;
    },
  };
}
