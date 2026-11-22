import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { fileItemPk, ITEM_META_SK } from "./release-objects.ts";
import type { SweepWriter } from "./release-sweep.ts";

// The only write adapters of the reconciler. The handler builds them in the
// real-run branch only. They delete the current version of an object under
// objects/ (never a version id) and write file items (`file#...`), nothing else.

type Send = Pick<DynamoDBDocumentClient, "send">;

async function conditional(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

export function sweepWriter(s3: Pick<S3Client, "send">, bucket: string, client: Send, table: string): SweepWriter {
  const key = (digest: string) => ({ pk: fileItemPk(digest), sk: ITEM_META_SK });
  const names = { "#s": "state" };
  return {
    async deleteObject(objectKey) {
      if (!objectKey.startsWith("objects/sha256/")) throw new Error("not_an_object_key");
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
    },
    markDeleting(digest, cutoff, now) {
      return conditional(() => client.send(new UpdateCommand({
        TableName: table, Key: key(digest),
        UpdateExpression: "SET #s = :deleting, deleting_at = :now",
        ConditionExpression: "refs = :zero AND #s = :condemned AND condemned_at <= :cutoff",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ":deleting": "deleting", ":now": now, ":zero": 0, ":condemned": "condemned", ":cutoff": cutoff },
      })));
    },
    markDeleted(digest) {
      return conditional(() => client.send(new UpdateCommand({
        TableName: table, Key: key(digest),
        UpdateExpression: "SET #s = :deleted", ConditionExpression: "#s = :deleting",
        ExpressionAttributeNames: names, ExpressionAttributeValues: { ":deleted": "deleted", ":deleting": "deleting" },
      })));
    },
    revertDeleting(digest, to) {
      return conditional(() => client.send(new UpdateCommand({
        TableName: table, Key: key(digest),
        UpdateExpression: to === "live" ? "SET #s = :to REMOVE deleting_at, condemned_at" : "SET #s = :to REMOVE deleting_at",
        ConditionExpression: "#s = :deleting",
        ExpressionAttributeNames: names, ExpressionAttributeValues: { ":to": to, ":deleting": "deleting" },
      })));
    },
    condemnOrphan(digest, bytes, now) {
      return conditional(() => client.send(new PutCommand({
        TableName: table,
        Item: { ...key(digest), state: "condemned", refs: 0, bytes, condemned_at: now },
        ConditionExpression: "attribute_not_exists(pk)",
      })));
    },
  };
}

/** Builds the real clients. Call it only when the sweep is allowed to write. */
export function createSweepWriter(bucket: string, table: string): SweepWriter {
  return sweepWriter(new S3Client({}), bucket, DynamoDBDocumentClient.from(new DynamoDBClient({})), table);
}
