import { roleOf } from "../../access/domain.ts";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Caller, type Response, response } from "./http.ts";
import { observe, resolveIdentity, bootstrapOwner, identityAccounts } from "./identity-store.ts";
import { providerPhoto } from "../../access/avatar.ts";
import { avatarLink, copyProviderAvatar } from "./avatars.ts";
import { requestAccountAccess } from "../../access/account-writes.ts";
import { document, tableName, type Item } from "./access-store.ts";

export async function session(account: Caller, capabilities: readonly string[]): Promise<Response> {
  const observed = await observe(account);
  const identity = await resolveIdentity(account, observed) ?? await bootstrapOwner(account);
  if (identity !== null) {
    const role = roleOf(identity);
    const bootstrap = await document.send(new GetCommand({ TableName: tableName, Key: { pk: "SYSTEM", sk: "BOOTSTRAP" } }));
    // The Owner's Telegram id is personal data that no member needs once the claim is made.
    const profile = accountProfile(account, observed);
    // The identity's own avatar (ADR-0084), copied once from a provider photo when it has none.
    const key = identity.avatarKey ?? (identity.avatarRemoved ? null
      : await copyProviderAvatar(identity, providerPhoto(await identityAccounts(identity), account)));
    profile.photoUrl = key !== null ? await avatarLink(key) : identity.avatarRemoved ? null : profile.photoUrl;
    return response(200, { state: "active", identity, role, capabilities, profile,
      bootstrap: bootstrap.Item === undefined ? { state: "unclaimed" } : {
        state: "claimed", ownerId: bootstrap.Item.identity_id, telegramId: null, claimedAt: bootstrap.Item.claimed_at,
      } });
  }
  return response(200, { state: "visitor", candidate: {
    ...accountProfile(account, observed), displayName: observed.display_name, status: observed.status ?? "OBSERVED",
  } });
}

// The account a session was signed in through, as the panel shows it. The
// Telegram id stays a named field because the owner bootstrap and the
// Mini App read it; every other provider is described by its handle or email.
function accountProfile(account: Caller, observed: Item): {
  provider: string; platformUserId: string; telegramId: string | null; username: string | null; email: string | null; photoUrl: string | null;
} {
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
    await document.send(new UpdateCommand(requestAccountAccess(tableName, account.provider, account.subject, now, true)));
  } catch {
    if (await resolveIdentity(account) !== null) return response(409, { error: "already_approved" });
    throw new Error("access candidate is unavailable");
  }
  return response(202, { state: "requested" });
}
