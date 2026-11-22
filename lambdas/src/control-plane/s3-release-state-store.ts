import {
  GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";

import type { ReleaseHolders, WorldIdentity } from "./release-holders.ts";
import {
  legacyReleaseStateKey, parseLegacyReleaseState, parseReleaseState, releaseStateDocument,
  releaseStateKey, type ReleaseState, type WorldRef,
} from "./release-state.ts";

export type StoredReleaseState = Readonly<{ state: ReleaseState; etag: string }>;

function missing(error: unknown): boolean {
  return error instanceof NoSuchKey || (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"));
}

/** Reads pointers and has no write method: the type a read-only call site holds (ADR-0080). */
export class S3ReleaseStateReader {
  protected readonly s3: S3Client;
  protected readonly bucket: string;

  constructor(s3: S3Client, bucket: string) {
    this.s3 = s3;
    this.bucket = bucket;
  }

  protected async readObject(key: string): Promise<{ value: unknown; etag: string } | null> {
    try {
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = await response.Body?.transformToString();
      if (!body || !response.ETag) throw new Error(`invalid object: ${key}`);
      return { value: JSON.parse(body) as unknown, etag: response.ETag };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async read(ref: WorldRef): Promise<StoredReleaseState | null> {
    const stored = await this.readObject(releaseStateKey(ref));
    if (stored === null) return null;
    const state = parseReleaseState(stored.value, ref);
    if (state === null) throw new Error("invalid_release_state");
    return { state, etag: stored.etag };
  }
}

/** Every write adds the holders first, so a call site cannot forget them: the holders argument is required. */
export class S3ReleaseStateStore extends S3ReleaseStateReader {
  private readonly holders: ReleaseHolders;
  private readonly now: () => Date;

  constructor(s3: S3Client, bucket: string, holders: ReleaseHolders, now: () => Date = () => new Date()) {
    super(s3, bucket);
    this.holders = holders;
    this.now = now;
  }

  async readOrMigrateLegacy(ref: WorldRef): Promise<StoredReleaseState | null> {
    const current = await this.read(ref);
    if (current !== null) return current;
    const legacy = await this.readObject(legacyReleaseStateKey(ref.worldId));
    if (legacy === null) return null;
    const migrated = parseLegacyReleaseState(legacy.value, ref, this.now().toISOString());
    if (migrated === null) throw new Error("invalid_legacy_release_state");
    try {
      await this.create(migrated);
    } catch (error) {
      if (!(error instanceof Error) || (error.name !== "PreconditionFailed" && error.name !== "ConditionalRequestConflict")) throw error;
    }
    const stored = await this.read(ref);
    if (stored === null) throw new Error("release_state_migration_failed");
    return stored;
  }

  /** `world` is the game and preset when the world record is not stored yet; otherwise they are read from it. */
  async create(state: ReleaseState, world?: WorldIdentity): Promise<void> {
    await this.holders.holdPointer(state, world);
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: releaseStateKey(state),
      Body: JSON.stringify(releaseStateDocument(state)),
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
      IfNoneMatch: "*",
    }));
  }

  async replace(state: ReleaseState, etag: string, world?: WorldIdentity): Promise<void> {
    if (!etag) throw new Error("missing_release_state_etag");
    await this.holders.holdPointer(state, world);
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: releaseStateKey(state),
      Body: JSON.stringify(releaseStateDocument(state)),
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
      IfMatch: etag,
    }));
  }
}
