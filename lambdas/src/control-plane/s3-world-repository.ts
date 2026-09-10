import {
  GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";

import { parseWorldRecord, worldRecordDocument, type WorldRecord } from "./world-registry.ts";

export type StoredWorld = Readonly<{ record: WorldRecord; etag: string }>;

const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

function key(worldId: string): string {
  if (!WORLD_ID.test(worldId)) throw new Error("invalid_world_id");
  return `worlds/${worldId}/world.json`;
}

function missing(error: unknown): boolean {
  return error instanceof NoSuchKey || (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"));
}

export class S3WorldRepository {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(s3: S3Client, bucket: string) {
    this.s3 = s3;
    this.bucket = bucket;
  }

  async read(worldId: string): Promise<StoredWorld | null> {
    try {
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key(worldId) }));
      const body = await response.Body?.transformToString();
      if (!body || !response.ETag) throw new Error("invalid_world_record");
      const record = parseWorldRecord(JSON.parse(body) as unknown);
      if (record === null || record.worldId !== worldId) throw new Error("invalid_world_record");
      return { record, etag: response.ETag };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async list(): Promise<readonly WorldRecord[]> {
    const listing = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: "worlds/", MaxKeys: 500 }));
    const ids = (listing.Contents ?? []).flatMap((object) => {
      const match = object.Key?.match(/^worlds\/([a-z0-9][a-z0-9-]{0,31})\/world\.json$/);
      return match?.[1] ? [match[1]] : [];
    });
    const records = await Promise.all(ids.map(async (worldId) => {
      try {
        return (await this.read(worldId))?.record ?? null;
      } catch (error) {
        console.error("world_record_read_failed", { worldId, errorName: error instanceof Error ? error.name : "UnknownError" });
        return null;
      }
    }));
    return records.filter((record): record is WorldRecord => record !== null);
  }

  async create(record: WorldRecord): Promise<void> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key(record.worldId), Body: JSON.stringify(worldRecordDocument(record)),
      ContentType: "application/json", ServerSideEncryption: "AES256", IfNoneMatch: "*",
    }));
  }

  async replace(record: WorldRecord, etag: string): Promise<void> {
    if (!etag) throw new Error("missing_world_record_etag");
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key(record.worldId), Body: JSON.stringify(worldRecordDocument(record)),
      ContentType: "application/json", ServerSideEncryption: "AES256", IfMatch: etag,
    }));
  }
}
