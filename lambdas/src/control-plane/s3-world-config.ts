import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { releaseOverrideKey } from "./release-artifacts.ts";
import { objectKey } from "./release-objects.ts";
import { type ConfigFileStore, worldConfigFileKey } from "./world-config.ts";

function missing(error: unknown): boolean {
  return error instanceof NoSuchKey || (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"));
}

/** A world's config files beside its record in the release bucket, and the release's own files (ADR-0093). */
export function s3ConfigFileStore(s3: Pick<S3Client, "send">, bucket: () => string): ConfigFileStore {
  const read = async (key: string): Promise<Uint8Array | null> => {
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
      return object.Body === undefined ? new Uint8Array() : await object.Body.transformToByteArray();
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  };
  return {
    async putWorldFile(worldId, sha256, bytes) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket(), Key: worldConfigFileKey(worldId, sha256), Body: bytes,
        ContentType: "text/plain; charset=utf-8", ServerSideEncryption: "AES256",
      }));
    },
    readWorldFile: (worldId, sha256) => read(worldConfigFileKey(worldId, sha256)),
    readReleaseFile: (release, file) => read(release.objects ? objectKey(file.sha256) : releaseOverrideKey(release.gameId, release.presetId, release.release, file.path)),
  };
}

function releaseBucket(): string {
  const bucket = process.env.RELEASE_BUCKET;
  if (!bucket) throw new Error("missing environment variable: RELEASE_BUCKET");
  return bucket;
}

export const awsConfigFileStore: ConfigFileStore = s3ConfigFileStore(new S3Client({}), releaseBucket);
