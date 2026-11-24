import { type TableUpdate } from "./table.ts";
import { accountItemKey, candidateIndex } from "./keys.ts";

export type ObservedAccount = Readonly<{
  provider: string;
  subject: string;
  displayName: string;
  username: string | null;
  // Attributes that only some callers know. An absent one is left as stored.
  photoUrl?: string | null;
  email?: string | null;
  chatId?: string;
  directChatId?: string;
}>;

/**
 * Records that an account was seen. It creates the candidate as OBSERVED or
 * REQUESTED, and never changes the status or index of an existing one.
 */
export function observeAccount(tableName: string, account: ObservedAccount, requested: boolean, now: string): TableUpdate {
  const assignments = [
    "platform = :platform", "platform_user_id = :platformUserId", "display_name = :displayName", "username = :username",
    "first_seen_at = if_not_exists(first_seen_at, :now)", "last_seen_at = :now",
    "#status = if_not_exists(#status, :candidateStatus)",
    "gsi1pk = if_not_exists(gsi1pk, :candidateIndex)", "gsi1sk = :now",
  ];
  const values: Record<string, unknown> = {
    ":platform": account.provider, ":platformUserId": account.subject, ":displayName": account.displayName,
    ":username": account.username, ":now": now,
    ":candidateStatus": requested ? "REQUESTED" : "OBSERVED",
    ":candidateIndex": requested ? candidateIndex.requested : candidateIndex.observed,
  };
  const optional: readonly (readonly [string, string, unknown])[] = [
    ["photo_url", ":photoUrl", account.photoUrl], ["email", ":email", account.email],
    ["chat_id", ":chatId", account.chatId], ["direct_chat_id", ":directChatId", account.directChatId],
  ];
  for (const [attribute, placeholder, value] of optional) {
    if (value === undefined) continue;
    assignments.push(`${attribute} = ${placeholder}`);
    values[placeholder] = value;
  }
  return {
    TableName: tableName, Key: accountItemKey(account.provider, account.subject),
    UpdateExpression: `SET ${assignments.join(", ")}`,
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: values,
  };
}

/**
 * Marks a candidate as asking for access. It fails when an identity is linked
 * already. `mustExist` also fails when the account item is missing.
 */
export function requestAccountAccess(tableName: string, provider: string, subject: string, now: string, mustExist: boolean): TableUpdate {
  return {
    TableName: tableName, Key: accountItemKey(provider, subject),
    UpdateExpression: "SET #status = :requested, gsi1pk = :candidateIndex, requested_at = if_not_exists(requested_at, :now), gsi1sk = :now",
    ConditionExpression: mustExist ? "attribute_exists(pk) AND attribute_not_exists(identity_id)" : "attribute_not_exists(identity_id)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":requested": "REQUESTED", ":candidateIndex": candidateIndex.requested, ":now": now },
  };
}
