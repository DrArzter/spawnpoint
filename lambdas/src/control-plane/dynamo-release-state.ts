import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { ITEM_META_SK, RELEASE_REFS_TABLE_DEFAULT, releaseItemPk, type ReleaseItemState } from "./release-objects.ts";
import { parseReleaseItemState, type ReleaseStateReader } from "./release-usable.ts";

/** Reads one release item. A state this code does not know is an error: the release is not used on a guess. */
export function dynamoReleaseStateReader(
  client: Pick<DynamoDBDocumentClient, "send">,
  tableName: string = process.env.RELEASE_REFS_TABLE ?? RELEASE_REFS_TABLE_DEFAULT,
): ReleaseStateReader {
  return async (gameId, presetId, release) => {
    const { Item } = await client.send(new GetCommand({
      TableName: tableName,
      Key: { pk: releaseItemPk(gameId, presetId, release), sk: ITEM_META_SK },
      ConsistentRead: true,
    }));
    if (Item === undefined) return null;
    const state = parseReleaseItemState(Item.state);
    if (state === "unknown") throw new Error("release_state_unreadable");
    return state satisfies ReleaseItemState;
  };
}
