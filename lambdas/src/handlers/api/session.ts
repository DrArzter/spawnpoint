import { isBuiltInRoleId, builtInRoles } from "../../access/domain.ts";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Caller, type Response, response } from "./http.ts";
import { observe, resolveIdentity, bootstrapOwner, accountKey } from "./identity-store.ts";
import { document, tableName, type Item } from "./access-store.ts";

export async function session(account: Caller, capabilities: readonly string[]): Promise<Response> {
  const observed = await observe(account);
  const identity = await resolveIdentity(account, observed) ?? await bootstrapOwner(account);
  if (identity !== null) {
    const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : null;
    const bootstrap = await document.send(new GetCommand({ TableName: tableName, Key: { pk: "SYSTEM", sk: "BOOTSTRAP" } }));
    return response(200, { state: "active", identity, role, capabilities, profile: accountProfile(account, observed),
      bootstrap: bootstrap.Item === undefined ? { state: "unclaimed" } : {
        state: "claimed", ownerId: bootstrap.Item.identity_id, telegramId: bootstrap.Item.telegram_id, claimedAt: bootstrap.Item.claimed_at,
      } });
  }
  return response(200, { state: "visitor", candidate: {
    ...accountProfile(account, observed), displayName: observed.display_name, status: observed.status ?? "OBSERVED",
  } });
}

// The account a session was signed in through, as the panel shows it. The
// Telegram id stays a named field because the owner bootstrap and the
// Mini App read it; every other provider is described by its handle or email.
function accountProfile(account: Caller, observed: Item) {
  return {
    provider: account.provider,
    platformUserId: account.subject,
    telegramId: account.provider === "telegram" ? account.subject : null,
    username: typeof observed.username === "string" ? observed.username : null,
    email: typeof observed.email === "string" ? observed.email : null,
    photoUrl: typeof observed.photo_url === "string" ? observed.photo_url : null,
  };
}

export async function requestAccess(account: Caller): Promise<Response> {
  const now = new Date().toISOString();
  try {
    await document.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: accountKey(account), sk: "ACCOUNT" },
      UpdateExpression: "SET #status = :requested, gsi1pk = :candidateIndex, requested_at = if_not_exists(requested_at, :now), gsi1sk = :now",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":requested": "REQUESTED", ":candidateIndex": "CANDIDATE#REQUESTED", ":now": now },
    }));
  } catch {
    if (await resolveIdentity(account) !== null) return response(409, { error: "already_approved" });
    throw new Error("access candidate is unavailable");
  }
  return response(202, { state: "requested" });
}
