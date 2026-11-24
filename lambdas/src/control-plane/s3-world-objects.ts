import {
  DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand,
  NoSuchKey, PutObjectCommand, type S3Client,
} from "@aws-sdk/client-s3";

import type { BackupObject } from "./backups.ts";

/** A JSON document as stored, with the ETag a conditional write names. */
export type StoredJson = Readonly<{ value: Record<string, unknown>; etag: string }>;

/** The object operations the world lifecycle needs from the release and backup buckets. */
export type WorldObjects = Readonly<{
  readJson: (bucket: string, key: string) => Promise<StoredJson>;
  /** Null when the key holds no object. */
  readJsonIfAny: (bucket: string, key: string) => Promise<StoredJson | null>;
  /** Writes only when no object holds the key. */
  createJson: (bucket: string, key: string, document: unknown) => Promise<void>;
  /** Writes only when the object is still the one `etag` names. */
  replaceJson: (bucket: string, key: string, etag: string, document: unknown) => Promise<void>;
  /** Deletes every version and delete marker under the prefix, or of the exact key. */
  purge: (bucket: string, prefix: string, exactKey?: string) => Promise<void>;
  list: (bucket: string, prefix: string, maxKeys: number) => Promise<readonly BackupObject[]>;
  /** Every object under the prefix, page by page. */
  listAll: (bucket: string, prefix: string) => Promise<BackupObject[]>;
  exists: (bucket: string, key: string) => Promise<boolean>;
}>;

function missing(error: unknown): boolean {
  return error instanceof NoSuchKey || (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"));
}

export function s3WorldObjects(s3: S3Client): WorldObjects {
  const readJson = async (bucket: string, key: string): Promise<StoredJson> => {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await response.Body?.transformToString();
    if (!body || !response.ETag) throw new Error(`invalid object: ${key}`);
    const value = JSON.parse(body) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid object: ${key}`);
    return { value: value as Record<string, unknown>, etag: response.ETag };
  };

  const versions = async (bucket: string, prefix: string, exactKey?: string) => {
    const objects: Array<{ Key: string; VersionId: string }> = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const page = await s3.send(new ListObjectVersionsCommand({ // NOSONAR paginated: the next token comes from the previous page
        Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker,
      }));
      for (const object of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
        if (object.Key && object.VersionId && (exactKey === undefined || object.Key === exactKey)) {
          objects.push({ Key: object.Key, VersionId: object.VersionId });
        }
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker !== undefined);
    return objects;
  };

  const putJson = async (bucket: string, key: string, document: unknown, condition: { IfNoneMatch: string } | { IfMatch: string }) => {
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: key, ...condition, ContentType: "application/json", ServerSideEncryption: "AES256", Body: JSON.stringify(document),
    }));
  };

  return {
    readJson,
    readJsonIfAny: async (bucket, key) => {
      try {
        return await readJson(bucket, key);
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    createJson: (bucket, key, document) => putJson(bucket, key, document, { IfNoneMatch: "*" }),
    replaceJson: (bucket, key, etag, document) => putJson(bucket, key, document, { IfMatch: etag }),
    purge: async (bucket, prefix, exactKey) => {
      const objects = await versions(bucket, prefix, exactKey);
      for (let offset = 0; offset < objects.length; offset += 1000) {
        const page = objects.slice(offset, offset + 1000);
        const deleted = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: page, Quiet: true } })); // NOSONAR ordered, fail-fast purge batches
        if ((deleted.Errors ?? []).length > 0) throw new Error("purge_delete_failed");
      }
    },
    list: async (bucket, prefix, maxKeys) => {
      const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: maxKeys }));
      return (listing.Contents ?? []).flatMap((object) => object.Key && object.LastModified ? [{
        key: object.Key, sizeBytes: object.Size ?? 0, storedAt: object.LastModified.toISOString(),
        checksumAlgorithms: object.ChecksumAlgorithm ?? [],
      }] : []);
    },
    listAll: async (bucket, prefix) => {
      const objects: BackupObject[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ // NOSONAR paginated: the next token comes from the previous page
          Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}),
        }));
        for (const object of page.Contents ?? []) {
          if (object.Key && object.LastModified) {
            objects.push({ key: object.Key, sizeBytes: object.Size ?? 0, storedAt: object.LastModified.toISOString(), checksumAlgorithms: object.ChecksumAlgorithm ?? [] });
          }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },
    exists: async (bucket, key) => {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        if (missing(error)) return false;
        throw error;
      }
    },
  };
}
