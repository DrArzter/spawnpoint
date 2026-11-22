import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import {
  fileItemPk, ITEM_META_SK, releaseItemPk, RELEASE_REFS_TABLE_DEFAULT, isSha256,
  type FileItemState, type ReleaseItemState, type ReleaseLayout,
} from "./release-objects.ts";

// The writer's side of the reference table (ADR-0080, design 4.8). Every step
// adds a reference before the file or the record is needed, and removes none:
// a crash keeps a file too long and never loses one. Removal belongs to
// retirement and the reconciler, which are later work.

export type ReleaseRef = Readonly<{ gameId: string; presetId: string; release: string }>;

export type ReleaseItem = Readonly<{ layout: ReleaseLayout; state: ReleaseItemState; holders: number }>;
export type FileItem = Readonly<{ state: FileItemState; refs: number; bytes: number }>;

export type HolderRole = "origin" | "desired" | "active" | "run" | "pre-promotion" | "catalog";

/** The holder's sort key is `hold#` plus one of these. */
export const holderKey = {
  generation: (worldId: string, generationId: string) => `gen#${worldId}/${generationId}`,
  catalog: (gameId: string) => `catalog#${gameId}`,
  build: (buildId: string) => `build#${buildId}`,
  backup: (key: string, versionId: string) => `backup#${key}#${versionId}`,
} as const;

type Client = Pick<DynamoDBDocumentClient, "send">;
type Reason = Readonly<{ Code?: string; Item?: Record<string, unknown> }>;

export class ReleaseRefsError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ReleaseRefsError";
  }
}

const HOLDER_STATES: Readonly<Record<"build" | "other", readonly ReleaseItemState[]>> = {
  build: ["building", "live"],
  other: ["live"],
};

function cancellationReasons(error: unknown): readonly Reason[] | null {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return null;
  return (error as { CancellationReasons?: readonly Reason[] }).CancellationReasons ?? [];
}

function failed(reason: Reason | undefined): boolean {
  return reason?.Code === "ConditionalCheckFailed";
}

function unusable(state: ReleaseItemState): ReleaseRefsError {
  return new ReleaseRefsError(state === "building" ? "release_not_ready" : "release_retired");
}

export type FileClaim = Readonly<{ sha256: string; bytes: number; path: string }>;

/** What the writer does with the bytes of one claimed file. */
export type ObjectMode = "create" | "verify" | "recreate";

export type ClaimOptions = Readonly<{
  /** Called for one file after its reference is counted, or, for a deleted file, before it is revived. */
  ensureObject: (file: FileClaim, mode: ObjectMode) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  /** How long a build waits for a delete in progress to end. */
  waitMilliseconds?: number;
}>;

export class ReleaseRefs {
  private readonly client: Client;
  private readonly table: string;
  private readonly now: () => Date;

  constructor(client: Client, table: string = process.env.RELEASE_REFS_TABLE ?? RELEASE_REFS_TABLE_DEFAULT, now: () => Date = () => new Date()) {
    this.client = client;
    this.table = table;
    this.now = now;
  }

  private key(ref: ReleaseRef, sk: string) {
    return { pk: releaseItemPk(ref.gameId, ref.presetId, ref.release), sk };
  }

  async readRelease(ref: ReleaseRef): Promise<ReleaseItem | null> {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: this.key(ref, ITEM_META_SK), ConsistentRead: true }));
    if (Item === undefined) return null;
    return { layout: Item.layout as ReleaseLayout, state: Item.state as ReleaseItemState, holders: Number(Item.holders ?? 0) };
  }

  /** One consistent read: does this holder already carry every role? Then `hold` has nothing to write. */
  async holds(ref: ReleaseRef, key: string, roles: readonly (HolderRole | "build")[]): Promise<boolean> {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: this.key(ref, `hold#${key}`), ConsistentRead: true }));
    if (Item === undefined || !(Item.roles instanceof Set)) return false;
    const have = Item.roles as Set<string>;
    return roles.every((role) => have.has(role));
  }

  /** A release the table does not know is a legacy one: registered live, with no file references, never swept. */
  async registerLegacy(ref: ReleaseRef): Promise<void> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.table,
        Item: { ...this.key(ref, ITEM_META_SK), layout: "legacy", state: "live", holders: 0, registered_at: this.now().toISOString() },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
    } catch (error) {
      if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
    }
  }

  /** Starts a build: the release item (state building) and the build's own holder. Safe to repeat. */
  async beginBuild(ref: ReleaseRef, buildId: string, profileDigest?: string): Promise<void> {
    const existing = await this.readRelease(ref);
    if (existing === null) {
      try {
        await this.client.send(new TransactWriteCommand({
          TransactItems: [
            { Put: {
              TableName: this.table,
              Item: {
                ...this.key(ref, ITEM_META_SK), layout: "objects", state: "building", holders: 1,
                ...(profileDigest === undefined ? {} : { profile_digest: profileDigest }), created_at: this.now().toISOString(),
              },
              ConditionExpression: "attribute_not_exists(pk)",
            } },
            { Put: {
              TableName: this.table,
              Item: { ...this.key(ref, `hold#${holderKey.build(buildId)}`), roles: new Set(["build"]), added_at: this.now().toISOString() },
              ConditionExpression: "attribute_not_exists(pk)",
            } },
          ],
        }));
        return;
      } catch (error) {
        if (cancellationReasons(error) === null) throw error;
        // Another builder created the item first: join it.
      }
    }
    await this.hold(ref, holderKey.build(buildId), ["build"]);
  }

  /** Adds a holder, or a role to the holder that exists. Refuses a release that is retiring, retired or, for most holders, not live, also for a holder that exists. */
  async hold(ref: ReleaseRef, key: string, roles: readonly (HolderRole | "build")[]): Promise<void> {
    const isBuild = key.startsWith("build#");
    // DynamoDB refuses an empty set, so a holder always names a role.
    if (roles.length === 0) throw new ReleaseRefsError("holder_needs_a_role");
    let release = await this.releaseForHolder(ref, isBuild);
    // An existing holder gets no pass: a pointer that turns back to a retiring
    // release could otherwise slip in after the retirement's live check.
    const allowed = HOLDER_STATES[isBuild ? "build" : "other"];
    if (!allowed.includes(release.state)) throw unusable(release.state);
    const sk = `hold#${key}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: this.key(ref, sk), ConsistentRead: true })); // NOSONAR retry: each attempt reads what the last one changed
      if (Item !== undefined) {
        await this.addRoles(ref, sk, Item.roles, roles);
        return;
      }
      if (await this.addHolder(ref, sk, roles, allowed)) return; // NOSONAR retry: the next attempt depends on this write
      // The item appeared (another writer: loop and add the role) or the state moved.
      release = await this.readRelease(ref) ?? release; // NOSONAR retry: the state decides whether the next attempt may write
      if (!allowed.includes(release.state)) throw unusable(release.state);
    }
    throw new ReleaseRefsError("holder_conflict");
  }

  /** The release item a holder needs; an unknown release is registered as legacy, except for a build. */
  private async releaseForHolder(ref: ReleaseRef, isBuild: boolean): Promise<ReleaseItem> {
    const release = await this.readRelease(ref);
    if (release !== null) return release;
    if (isBuild) throw new ReleaseRefsError("release_not_begun");
    await this.registerLegacy(ref);
    const registered = await this.readRelease(ref);
    if (registered === null) throw new ReleaseRefsError("release_state_unreadable");
    return registered;
  }

  /** A holder that exists: add the roles it lacks. */
  private async addRoles(ref: ReleaseRef, sk: string, stored: unknown, roles: readonly string[]): Promise<void> {
    const have = new Set<string>(stored instanceof Set ? [...stored as Set<string>] : []);
    if (roles.every((role) => have.has(role))) return;
    await this.client.send(new UpdateCommand({
      TableName: this.table, Key: this.key(ref, sk),
      UpdateExpression: "ADD roles :roles", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":roles": new Set(roles) },
    }));
  }

  /** The holder item and the count, in one transaction that needs the release in an allowed state. False when it was cancelled. */
  private async addHolder(ref: ReleaseRef, sk: string, roles: readonly string[], allowed: readonly ReleaseItemState[]): Promise<boolean> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          { Put: {
            TableName: this.table,
            Item: { ...this.key(ref, sk), roles: new Set(roles), added_at: this.now().toISOString() },
            ConditionExpression: "attribute_not_exists(pk)",
          } },
          { Update: {
            TableName: this.table, Key: this.key(ref, ITEM_META_SK),
            UpdateExpression: "ADD holders :one",
            ConditionExpression: allowed.length === 1 ? "#s = :a" : "#s IN (:a, :b)",
            ExpressionAttributeNames: { "#s": "state" },
            ExpressionAttributeValues: { ":one": 1, ":a": allowed[0], ...(allowed.length === 1 ? {} : { ":b": allowed[1] }) },
          } },
        ],
      }));
      return true;
    } catch (error) {
      if (cancellationReasons(error) === null) throw error;
      return false;
    }
  }

  /** Removes one holder, as a build does when it has published. */
  async dropHolder(ref: ReleaseRef, key: string): Promise<void> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: this.table, Key: this.key(ref, `hold#${key}`), ConditionExpression: "attribute_exists(pk)" } },
          { Update: {
            TableName: this.table, Key: this.key(ref, ITEM_META_SK),
            UpdateExpression: "ADD holders :minus", ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeValues: { ":minus": -1 },
          } },
        ],
      }));
    } catch (error) {
      if (cancellationReasons(error) === null) throw error;
      // The holder is already gone: nothing to subtract.
    }
  }

  /** The manifest is written: the release is live. Safe to repeat. */
  async publish(ref: ReleaseRef): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.table, Key: this.key(ref, ITEM_META_SK),
        UpdateExpression: "SET #s = :live", ConditionExpression: "#s IN (:building, :live)",
        ExpressionAttributeNames: { "#s": "state" },
        ExpressionAttributeValues: { ":live": "live", ":building": "building" },
      }));
    } catch (error) {
      if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
      const now = await this.readRelease(ref);
      throw unusable(now?.state ?? "retired");
    }
  }

  async readFiles(digests: readonly string[]): Promise<Map<string, FileItem>> {
    const found = new Map<string, FileItem>();
    // One consistent read each: a batch read cannot be strongly consistent per item here and a stale `deleted` would cost a re-upload only, but a stale `live` could skip one.
    await Promise.all(digests.map(async (sha256) => {
      const item = await this.readFile(sha256);
      if (item !== null) found.set(sha256, item);
    }));
    return found;
  }

  async readFile(sha256: string): Promise<FileItem | null> {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: { pk: fileItemPk(sha256), sk: ITEM_META_SK }, ConsistentRead: true }));
    if (Item === undefined) return null;
    return { state: Item.state as FileItemState, refs: Number(Item.refs ?? 0), bytes: Number(Item.bytes ?? 0) };
  }

  private backReference(ref: ReleaseRef, file: FileClaim) {
    return { Put: {
      TableName: this.table,
      Item: {
        pk: fileItemPk(file.sha256), sk: `release#${ref.gameId}/${ref.presetId}/${ref.release}`,
        path: file.path, added_at: this.now().toISOString(),
      },
      ConditionExpression: "attribute_not_exists(pk)",
    } };
  }

  /**
   * Counts this release's reference to one file, then makes sure the bytes are
   * in the store (design 4.6, 4.8):
   * - a new or live file: the reference first, then the object is created or
   *   verified, so a crash between the two leaves a reference and no object,
   *   which the next run repairs;
   * - a file in `deleting`: wait until the sweeper finishes;
   * - a `deleted` file: upload the object again, then revive the item under the
   *   condition `state = deleted`.
   */
  async claimFile(ref: ReleaseRef, file: FileClaim, options: ClaimOptions): Promise<"created" | "reused" | "recreated"> {
    if (!isSha256(file.sha256)) throw new ReleaseRefsError("invalid_digest");
    const waitForDelete = this.deleteWait(options);
    for (;;) {
      const prior = await this.readFile(file.sha256); // NOSONAR retry: each attempt reads what the last one changed
      if (prior?.state === "deleting") {
        await waitForDelete(); // NOSONAR the sweeper must finish before this build writes
        continue;
      }
      if (prior?.state === "deleted") {
        if (await this.revive(ref, file, options)) return "recreated"; // NOSONAR retry: a lost revival reads the file again
        continue;
      }
      const outcome = await this.countReference(ref, file); // NOSONAR retry: a lost count reads the file again
      if (outcome === "lost") continue;
      // `counted` for the first time or already counted by an earlier attempt: either way the reference is in place.
      const created = prior === null && outcome === "done";
      await options.ensureObject(file, created ? "create" : "verify");
      return created ? "created" : "reused";
    }
  }

  /** Backs off while a file is `deleting`: doubling delays up to 30 s, and an error after the wait limit. */
  private deleteWait(options: ClaimOptions): () => Promise<void> {
    const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); }));
    const deadline = this.now().getTime() + (options.waitMilliseconds ?? 15 * 60_000);
    let delay = 500;
    return async () => {
      if (this.now().getTime() > deadline) throw new ReleaseRefsError("file_deleting_timeout");
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    };
  }

  /** A deleted file: the object again, then the item back to live. False when its state moved (read again). */
  private async revive(ref: ReleaseRef, file: FileClaim, options: ClaimOptions): Promise<boolean> {
    await options.ensureObject(file, "recreate");
    const outcome = await this.transact([
      { Update: {
        TableName: this.table, Key: { pk: fileItemPk(file.sha256), sk: ITEM_META_SK },
        UpdateExpression: "SET #s = :live, bytes = :bytes, refs = :one REMOVE condemned_at",
        ConditionExpression: "#s = :deleted",
        ExpressionAttributeNames: { "#s": "state" },
        ExpressionAttributeValues: { ":live": "live", ":bytes": file.bytes, ":one": 1, ":deleted": "deleted" },
      } },
      this.backReference(ref, file),
    ]);
    return outcome !== "lost";
  }

  /** A new or live file: count this release's reference. */
  private countReference(ref: ReleaseRef, file: FileClaim): Promise<"done" | "counted" | "lost"> {
    return this.transact([
      { Update: {
        TableName: this.table, Key: { pk: fileItemPk(file.sha256), sk: ITEM_META_SK },
        UpdateExpression: "SET #s = :live, bytes = :bytes ADD refs :one REMOVE condemned_at",
        ConditionExpression: "attribute_not_exists(pk) OR #s IN (:live, :condemned)",
        ExpressionAttributeNames: { "#s": "state" },
        ExpressionAttributeValues: { ":live": "live", ":condemned": "condemned", ":bytes": file.bytes, ":one": 1 },
      } },
      this.backReference(ref, file),
    ]);
  }

  /** `done`; `counted` (this release's reference was already there); `lost` (the file item's state moved: read again). */
  private async transact(items: readonly object[]): Promise<"done" | "counted" | "lost"> {
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items as never }));
      return "done";
    } catch (error) {
      const reasons = cancellationReasons(error);
      if (reasons === null) throw error;
      if (failed(reasons[1])) return "counted";
      return "lost";
    }
  }
}
