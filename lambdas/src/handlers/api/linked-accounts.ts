import { type Identity } from "../../access/domain.ts";
import { passwordProviderId } from "../../access/password-login-provider.ts";
import { type LoginProvider, authenticateWith } from "../../access/login-provider.ts";
import { type Response, response, type Event, parseJsonObject, errorResponse } from "./http.ts";
import { identityAccounts } from "./identity-store.ts";
import { loginProviderMarker } from "../../access/identity-creation.ts";
import { accountItemKey, identityIndex } from "../../access/keys.ts";
import { passwordCredentials } from "./credentials.ts";
import { proofLinkProviders } from "./login-providers.ts";
import { passwordLoginEnabled } from "./auth-config.ts";
import { emailDeliveryProvider } from "./aws-mail.ts";
import { accessTable, tableName } from "./access-store.ts";
import type { LinkedLoginAccount, LinkedLoginAccounts } from "../../../../contract/access.ts";

export async function linkedAccounts(identity: Identity): Promise<Response> {
  const accounts = await identityAccounts(identity);
  const linked = await Promise.all(accounts.map(async (account) => {
    const provider = typeof account.platform === "string" ? account.platform : "";
    const subject = typeof account.platform_user_id === "string" ? account.platform_user_id : "";
    let verified = true;
    if (provider === passwordProviderId && typeof account.email === "string") {
      verified = (await passwordCredentials.find(account.email))?.emailVerified === true;
    }
    return {
      provider,
      subject,
      displayName: typeof account.display_name === "string" ? account.display_name : null,
      username: typeof account.username === "string" ? account.username : null,
      email: typeof account.email === "string" ? account.email : null,
      photoUrl: typeof account.photo_url === "string" ? account.photo_url : null,
      verified,
    };
  }));
  const body: LinkedLoginAccounts = {
    accounts: linked,
    linkableProviders: [...proofLinkProviders.keys()],
    passwordManagementAvailable: passwordLoginEnabled && emailDeliveryProvider !== "none",
  };
  return response(200, body);
}

export async function linkProofAccount(identity: Identity, provider: LoginProvider, event: Event): Promise<Response> {
  const attempt = parseJsonObject(event);
  const principal = await authenticateWith(provider, attempt);
  if (principal === null) return errorResponse(401, `invalid_or_expired_${provider.id}_login`);
  const existing = await identityAccounts(identity);
  if (existing.some((account) => account.platform === provider.id)) {
    return errorResponse(409, "provider_already_linked");
  }

  const now = new Date().toISOString();
  try {
    await accessTable.transact({ TransactItems: [
      { Update: {
        TableName: tableName,
        Key: accountItemKey(principal.provider, principal.subject),
        UpdateExpression: [
          "SET platform = :provider", "platform_user_id = :subject", "display_name = :displayName",
          "username = :username", "photo_url = :photoUrl", "email = :email",
          "first_seen_at = if_not_exists(first_seen_at, :now)", "last_seen_at = :now",
          "identity_id = :identityId", "#status = :linked", "linked_at = :now", "linked_by = :identityId",
          "gsi1pk = :identityIndex", "gsi1sk = :now",
        ].join(", "),
        ConditionExpression: "attribute_not_exists(identity_id)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":provider": principal.provider,
          ":subject": principal.subject,
          ":displayName": principal.displayName,
          ":username": principal.username,
          ":photoUrl": principal.photoUrl,
          ":email": principal.email,
          ":now": now,
          ":identityId": identity.id,
          ":linked": "LINKED",
          ":identityIndex": identityIndex(identity.id),
        },
      } },
      { Put: {
        TableName: tableName,
        Item: loginProviderMarker(identity.id, provider.id, principal.subject, now),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] });
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      return errorResponse(409, "account_already_linked");
    }
    throw error;
  }
  const account: LinkedLoginAccount = {
    provider: principal.provider,
    subject: principal.subject,
    displayName: principal.displayName,
    username: principal.username,
    email: principal.email,
    photoUrl: principal.photoUrl,
    verified: true,
  };
  return response(201, { account });
}
