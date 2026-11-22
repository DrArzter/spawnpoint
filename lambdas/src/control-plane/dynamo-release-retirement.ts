import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, DeleteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { fileItemPk, ITEM_META_SK, releaseItemPk, RELEASE_REFS_TABLE_DEFAULT, type ReleaseLayout, type ReleaseItemState } from "./release-objects.ts";
import type { HolderRow, ReleaseRow, RetirementTable } from "./release-retirement.ts";
import type { ReleaseRef } from "./release-refs.ts";

// The retirement's table port. Every write is conditional; none touches an S3 object.

type Client = Pick<DynamoDBDocumentClient, "send">;
type Reason = Readonly<{ Code?: string }>;

function cancellationReasons(error: unknown): readonly Reason[] | null {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return null;
  return (error as { CancellationReasons?: readonly Reason[] }).CancellationReasons ?? [];
}

function conditionFailed(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "ConditionalCheckFailedException";
}

export function dynamoRetirementTable(client: Client, table: string = process.env.RELEASE_REFS_TABLE ?? RELEASE_REFS_TABLE_DEFAULT): RetirementTable {
  const releaseKey = (ref: ReleaseRef, sk: string) => ({ pk: releaseItemPk(ref.gameId, ref.presetId, ref.release), sk });
  return {
    async readRelease(ref): Promise<ReleaseRow | null> {
      const { Item } = await client.send(new GetCommand({ TableName: table, Key: releaseKey(ref, ITEM_META_SK), ConsistentRead: true }));
      if (Item === undefined) return null;
      return { layout: Item.layout as ReleaseLayout, state: Item.state as ReleaseItemState, holders: Number(Item.holders ?? 0) };
    },

    async transition(ref, from, to, options) {
      const at = new Date().toISOString();
      const sets = ["#s = :to"];
      const values: Record<string, unknown> = { ":to": to, ":from": from };
      const remove: string[] = [];
      if (to === "retiring") { sets.push("retiring_at = :at", "retiring_by = :by"); values[":at"] = at; values[":by"] = options.by ?? "unknown"; }
      if (to === "retired") { sets.push("retired_at = :at", "retired_by = :by"); values[":at"] = at; values[":by"] = options.by ?? "unknown"; }
      if (to === "live") remove.push("retiring_at", "retiring_by");
      if (options.noHolders === true) values[":zero"] = 0;
      try {
        await client.send(new UpdateCommand({
          TableName: table, Key: releaseKey(ref, ITEM_META_SK),
          UpdateExpression: `SET ${sets.join(", ")}${remove.length > 0 ? ` REMOVE ${remove.join(", ")}` : ""}`,
          ConditionExpression: `#s = :from${options.noHolders === true ? " AND holders = :zero" : ""}`,
          ExpressionAttributeNames: { "#s": "state" },
          ExpressionAttributeValues: values,
        }));
        return true;
      } catch (error) {
        if (conditionFailed(error)) return false;
        throw error;
      }
    },

    async listHolders(ref): Promise<readonly HolderRow[]> {
      const rows: HolderRow[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const page = await client.send(new QueryCommand({ // NOSONAR paginated: the start key comes from the previous page
          TableName: table, ConsistentRead: true,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :hold)",
          ExpressionAttributeValues: { ":pk": releaseItemPk(ref.gameId, ref.presetId, ref.release), ":hold": "hold#" },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }));
        for (const item of page.Items ?? []) rows.push({ sk: String(item.sk), addedAt: typeof item.added_at === "string" ? item.added_at : null });
        start = page.LastEvaluatedKey;
      } while (start);
      return rows;
    },

    async dropHolder(ref, sk) {
      try {
        await client.send(new TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName: table, Key: releaseKey(ref, sk), ConditionExpression: "attribute_exists(pk)" } },
            { Update: {
              TableName: table, Key: releaseKey(ref, ITEM_META_SK),
              UpdateExpression: "ADD holders :minus", ConditionExpression: "holders > :zero",
              ExpressionAttributeValues: { ":minus": -1, ":zero": 0 },
            } },
          ],
        }));
        return "dropped";
      } catch (error) {
        const reasons = cancellationReasons(error);
        if (reasons === null) throw error;
        // The holder is gone already (a repeat), or the counter is already 0 and the item remains: remove only the item.
        if (reasons[0]?.Code === "ConditionalCheckFailed") return "gone";
        await client.send(new DeleteCommand({ TableName: table, Key: releaseKey(ref, sk) }));
        return "dropped";
      }
    },

    async removeReference(ref, sha256) {
      const backReference = { pk: fileItemPk(sha256), sk: releaseItemPk(ref.gameId, ref.presetId, ref.release) };
      try {
        await client.send(new TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName: table, Key: backReference, ConditionExpression: "attribute_exists(pk)" } },
            { Update: {
              TableName: table, Key: { pk: fileItemPk(sha256), sk: ITEM_META_SK },
              UpdateExpression: "ADD refs :minus", ConditionExpression: "refs > :zero",
              ExpressionAttributeValues: { ":minus": -1, ":zero": 0 },
            } },
          ],
        }));
        return "removed";
      } catch (error) {
        const reasons = cancellationReasons(error);
        if (reasons === null) throw error;
        if (reasons[0]?.Code === "ConditionalCheckFailed") return "absent";
        // The back-reference exists but the counter cannot go lower: drop the reference alone.
        await client.send(new DeleteCommand({ TableName: table, Key: backReference }));
        return "drift";
      }
    },

    async condemnIfUnused(sha256, now) {
      const { Item } = await client.send(new GetCommand({ TableName: table, Key: { pk: fileItemPk(sha256), sk: ITEM_META_SK }, ConsistentRead: true }));
      if (Item === undefined || Number(Item.refs ?? 0) !== 0 || Item.state !== "live") return "kept";
      try {
        await client.send(new UpdateCommand({
          TableName: table, Key: { pk: fileItemPk(sha256), sk: ITEM_META_SK },
          UpdateExpression: "SET #s = :condemned, condemned_at = :now",
          ConditionExpression: "refs = :zero AND #s = :live",
          ExpressionAttributeNames: { "#s": "state" },
          ExpressionAttributeValues: { ":condemned": "condemned", ":now": now.toISOString(), ":zero": 0, ":live": "live" },
        }));
        return "condemned";
      } catch (error) {
        if (conditionFailed(error)) return "kept"; // a reuse won
        throw error;
      }
    },
  };
}
