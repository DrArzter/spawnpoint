import { verifyAccessToken, type LoginPrincipal, browserSessionCookieName, parseRefreshCredential, equalRefreshHashes, issueRefreshCredential, refreshSessionLifetimeSeconds, browserSessionCookie, expiredRefreshCookie, refreshCookieName, expiredBrowserSessionCookie } from "../../access/login-session.ts";
import { verifySessionToken } from "../../access/telegram-auth.ts";
import { telegramPrincipal } from "../../access/telegram-login-provider.ts";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Event, type Caller, requestCookie, type Response, responseWithCookies, response } from "./http.ts";
import { sessionSigningSecret, botToken } from "./secrets.ts";
import { document, tableName, type Item } from "./access-store.ts";
import { refreshCookieSameSite } from "./auth-config.ts";

export async function caller(event: Event): Promise<Caller | null> {
  const authorization = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1] ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization);
  if (match === null) return browserSessionPrincipal(event);
  const current = verifyAccessToken(match[1]!, await sessionSigningSecret())?.principal;
  if (current !== undefined) return current;
  const legacy = verifySessionToken(match[1]!, await botToken());
  return legacy === null ? null : telegramPrincipal(legacy);
}

async function browserSessionPrincipal(event: Event): Promise<LoginPrincipal | null> {
  const token = requestCookie(event, browserSessionCookieName);
  const supplied = token === null ? null : parseRefreshCredential(token);
  if (supplied === null) return null;
  const result = await document.send(new GetCommand({
    TableName: tableName,
    Key: loginSessionKey(supplied.loginSessionId),
    ConsistentRead: true,
  }));
  const item = result.Item;
  if (
    item === undefined || item.status !== "ACTIVE" ||
    typeof item.expires_at !== "number" || item.expires_at <= Math.floor(Date.now() / 1000) ||
    typeof item.token_hash !== "string" || !equalRefreshHashes(item.token_hash, supplied.tokenHash)
  ) return null;
  return principalFromLoginSession(item);
}

function loginSessionKey(loginSessionId: string): Record<string, string> {
  return { pk: `LOGIN_SESSION#${loginSessionId}`, sk: "REFRESH" };
}

function principalFromLoginSession(item: Item): LoginPrincipal | null {
  if (
    typeof item.provider !== "string" ||
    typeof item.subject !== "string" ||
    typeof item.display_name !== "string"
  ) return null;
  return {
    provider: item.provider,
    subject: item.subject,
    displayName: item.display_name,
    username: typeof item.username === "string" ? item.username : null,
    photoUrl: typeof item.photo_url === "string" ? item.photo_url : null,
    email: typeof item.email === "string" ? item.email : null,
  };
}

export async function createLoginSession(principal: LoginPrincipal): Promise<Response> {
  const credential = issueRefreshCredential();
  const createdAt = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + refreshSessionLifetimeSeconds;
  await document.send(new PutCommand({
    TableName: tableName,
    Item: {
      ...loginSessionKey(credential.loginSessionId),
      entity_type: "LOGIN_SESSION",
      status: "ACTIVE",
      provider: principal.provider,
      subject: principal.subject,
      display_name: principal.displayName,
      username: principal.username,
      photo_url: principal.photoUrl,
      email: principal.email,
      token_hash: credential.tokenHash,
      created_at: createdAt,
      expires_at: expiresAt,
      ttl: expiresAt,
      gsi1pk: `ACCOUNT#${principal.provider}#${principal.subject}`,
      gsi1sk: `LOGIN_SESSION#${createdAt}#${credential.loginSessionId}`,
    },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  return responseWithCookies(200, { authenticated: true }, [
    browserSessionCookie(credential.token, refreshCookieSameSite),
    expiredRefreshCookie(refreshCookieSameSite),
  ]);
}

export async function refreshLoginSession(event: Event): Promise<Response> {
  const cookie = requestCookie(event, browserSessionCookieName) ?? requestCookie(event, refreshCookieName);
  const supplied = cookie === null ? null : parseRefreshCredential(cookie);
  if (supplied === null) return response(401, { error: "invalid_or_expired_refresh_session" });

  const result = await document.send(new GetCommand({
    TableName: tableName,
    Key: loginSessionKey(supplied.loginSessionId),
    ConsistentRead: true,
  }));
  const item = result.Item;
  const now = Math.floor(Date.now() / 1000);
  const principal = item === undefined ? null : principalFromLoginSession(item);
  if (
    item === undefined || item.status !== "ACTIVE" ||
    typeof item.expires_at !== "number" || item.expires_at <= now ||
    typeof item.token_hash !== "string" || !equalRefreshHashes(item.token_hash, supplied.tokenHash) ||
    principal === null
  ) return response(401, { error: "invalid_or_expired_refresh_session" });

  const rotated = issueRefreshCredential(supplied.loginSessionId);
  try {
    await document.send(new UpdateCommand({
      TableName: tableName,
      Key: loginSessionKey(supplied.loginSessionId),
      UpdateExpression: "SET token_hash = :nextHash, last_refreshed_at = :now",
      ConditionExpression: "#status = :active AND token_hash = :previousHash AND expires_at > :nowEpoch",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":active": "ACTIVE",
        ":previousHash": supplied.tokenHash,
        ":nextHash": rotated.tokenHash,
        ":now": new Date().toISOString(),
        ":nowEpoch": now,
      },
    }));
  } catch {
    // Another tab may have rotated the shared cookie first. The client may retry
    // once with the newest cookie; do not revoke the whole login session here.
    return response(401, { error: "refresh_credential_rotated" });
  }
  return responseWithCookies(200, { authenticated: true }, [
    browserSessionCookie(rotated.token, refreshCookieSameSite),
    expiredRefreshCookie(refreshCookieSameSite),
  ]);
}

export async function logoutLoginSession(event: Event): Promise<Response> {
  const cookie = requestCookie(event, browserSessionCookieName) ?? requestCookie(event, refreshCookieName);
  const supplied = cookie === null ? null : parseRefreshCredential(cookie);
  if (supplied !== null) {
    try {
      await document.send(new UpdateCommand({
        TableName: tableName,
        Key: loginSessionKey(supplied.loginSessionId),
        UpdateExpression: "SET #status = :revoked, revoked_at = :now",
        ConditionExpression: "#status = :active AND token_hash = :tokenHash",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":active": "ACTIVE",
          ":revoked": "REVOKED",
          ":tokenHash": supplied.tokenHash,
          ":now": new Date().toISOString(),
        },
      }));
    } catch {
      // Logout is idempotent and never reveals whether a credential existed.
    }
  }
  return responseWithCookies(204, null, [
    expiredBrowserSessionCookie(refreshCookieSameSite),
    expiredRefreshCookie(refreshCookieSameSite),
  ]);
}
