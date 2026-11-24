import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { BackupArchives } from "./backups.ts";
import { attachmentDisposition } from "./release-artifacts.ts";
import { s3BackupReleaseSources } from "./s3-backup-release.ts";

type Buckets = Readonly<{ backups: () => string; releases: () => string }>;

/** A world's archives in the backup bucket (ADR-0065). */
export function s3BackupArchives(s3: S3Client, buckets: Buckets): BackupArchives {
  return {
    // The inventory is a listing: the digest lives in the key and the listing
    // reports each object's checksum algorithm, so listing never reads an archive.
    list: async (worldId) => {
      const response = await s3.send(new ListObjectsV2Command({
        Bucket: buckets.backups(), Prefix: `worlds/${worldId}/archives/`, MaxKeys: 200,
      }));
      return (response.Contents ?? []).flatMap((object) => object.Key && object.LastModified ? [{
        key: object.Key,
        sizeBytes: object.Size ?? 0,
        storedAt: object.LastModified.toISOString(),
        checksumAlgorithms: object.ChecksumAlgorithm ?? [],
      }] : []);
    },
    // The caller has checked that the key is this world's; a key with no
    // object is a normal answer, not an error.
    link: async (key, expiresIn) => {
      const bucket = buckets.backups();
      let sizeBytes: number;
      try {
        sizeBytes = (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength ?? 0;
      } catch (error) {
        if ((error as { name?: string }).name === "NotFound") return null;
        throw error;
      }
      const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: bucket, Key: key, ResponseContentDisposition: attachmentDisposition(key.slice(key.lastIndexOf("/") + 1)),
      }), { expiresIn });
      return { url, sizeBytes };
    },
    // Each archive's recorded release and its wipe's pointer: one HEAD per archive, never a download.
    releaseSources: () => s3BackupReleaseSources(s3, buckets.backups(), buckets.releases()),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
}

export const awsBackupArchives: BackupArchives = s3BackupArchives(new S3Client({}), {
  backups: () => requiredEnv("BACKUP_BUCKET"),
  releases: () => requiredEnv("RELEASE_BUCKET"),
});
