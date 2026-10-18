import { type EmailActionPurpose, type EmailAction, renderEmailAction, issueEmailAction, emailActionTokenHash } from "../../access/email-actions.ts";
import { type PasswordCredential, passwordProviderId, passwordPrincipal } from "../../access/password-login-provider.ts";
import { TransactWriteCommand, GetCommand, type TransactWriteCommandInput, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { normalizeEmail, validatePassword, hashPassword } from "../../access/password-credential.ts";
import { accessInvitationTokenHash, accessInvitationUsable } from "../../access/access-invitations.ts";
import { type Item, document, tableName } from "./access-store.ts";
import { emailSender, emailDeliveryProvider } from "./mail.ts";
import { panelUrl } from "./origins.ts";
import { credentialKey, passwordCredentials, credentialFromItem } from "./credentials.ts";
import { type Response, response, type Event, objectBody } from "./http.ts";
import { accessInvitationKey } from "./access-invitations.ts";
import { accountKeyFor } from "./identity-store.ts";
import { createLoginSession } from "./login-sessions.ts";

function emailActionKey(tokenHash: string): Record<string, string> {
  return { pk: `EMAIL_ACTION#${tokenHash}`, sk: "TOKEN" };
}

export function emailActionItem(
  purpose: EmailActionPurpose,
  action: EmailAction,
  credential: Pick<PasswordCredential, "subject" | "email" | "displayName">,
  identityId?: string,
): Item {
  const createdAt = new Date().toISOString();
  return {
    ...emailActionKey(action.tokenHash),
    entity_type: "EMAIL_ACTION_TOKEN",
    purpose,
    nonce: action.nonce,
    subject: credential.subject,
    email: credential.email,
    display_name: credential.displayName,
    status: "PENDING",
    created_at: createdAt,
    expires_at: action.expiresAtEpochSeconds,
    ttl: action.expiresAtEpochSeconds,
    ...(identityId === undefined ? {} : { identity_id: identityId }),
  };
}

export async function deliverEmailAction(
  purpose: EmailActionPurpose,
  action: EmailAction,
  credential: Pick<PasswordCredential, "subject" | "email" | "displayName">,
  invitationToken?: string,
): Promise<boolean> {
  const sender = await emailSender();
  if (sender === null) return false;
  await sender.send(renderEmailAction(purpose, { email: credential.email, displayName: credential.displayName, panelUrl, action, ...(invitationToken ? { invitationToken } : {}) }));
  return true;
}

async function replaceEmailAction(
  purpose: EmailActionPurpose,
  credential: PasswordCredential,
  identityId?: string,
): Promise<EmailAction> {
  const action = issueEmailAction(purpose);
  const nonceField = purpose === "verify_email" ? "email_verification_nonce" : "password_reset_nonce";
  await document.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: tableName,
      Key: credentialKey(credential.email),
      UpdateExpression: `SET ${nonceField} = :nonce`,
      ConditionExpression: "subject = :subject",
      ExpressionAttributeValues: { ":nonce": action.nonce, ":subject": credential.subject },
    } },
    { Put: {
      TableName: tableName,
      Item: emailActionItem(purpose, action, credential, identityId),
      ConditionExpression: "attribute_not_exists(pk)",
    } },
  ] }));
  return action;
}

function emailActionsUnavailable(): Response | null {
  return emailDeliveryProvider === "none" ? response(404, { error: "not_found" }) : null;
}

export async function resendEmailVerification(event: Event): Promise<Response> {
  const unavailable = emailActionsUnavailable();
  if (unavailable !== null) return unavailable;
  const parsed = objectBody(event);
  const email = normalizeEmail(parsed?.email);
  if (email === null) return response(202, { result: "accepted" });
  const invitationToken = parsed?.invitationToken;
  if (invitationToken !== undefined) {
    const tokenHash = accessInvitationTokenHash(invitationToken);
    if (tokenHash === null) return response(400, { error: "invalid_or_expired_invitation" });
    const invitation = await document.send(new GetCommand({ TableName: tableName, Key: accessInvitationKey(tokenHash), ConsistentRead: true }));
    if (!accessInvitationUsable(invitation.Item)) return response(400, { error: "invalid_or_expired_invitation" });
    if (invitation.Item?.delivery_email !== email) return response(403, { error: "invited_email_mismatch" });
  }
  const credential = await passwordCredentials.find(email);
  if (credential === null || credential.emailVerified) return response(202, { result: "accepted" });
  const account = await document.send(new GetCommand({
    TableName: tableName,
    Key: { pk: accountKeyFor(passwordProviderId, credential.subject), sk: "ACCOUNT" },
    ConsistentRead: true,
  }));
  const action = await replaceEmailAction(
    "verify_email",
    credential,
    typeof account.Item?.identity_id === "string" ? account.Item.identity_id : undefined,
  );
  await deliverEmailAction("verify_email", action, credential, typeof invitationToken === "string" ? invitationToken : undefined);
  return response(202, { result: "accepted" });
}

function actionFromItem(item: Item | undefined, purpose: EmailActionPurpose, nowEpochSeconds: number): Item | null {
  if (
    item?.entity_type !== "EMAIL_ACTION_TOKEN" || item.purpose !== purpose || item.status !== "PENDING"
    || typeof item.nonce !== "string" || typeof item.subject !== "string" || typeof item.email !== "string"
    || typeof item.expires_at !== "number" || item.expires_at <= nowEpochSeconds
  ) return null;
  return item;
}

async function readEmailAction(event: Event, purpose: EmailActionPurpose): Promise<{ tokenHash: string; item: Item } | Response> {
  const parsed = objectBody(event);
  const tokenHash = emailActionTokenHash(typeof parsed?.token === "string" ? parsed.token : "");
  if (tokenHash === null) return response(400, { error: "invalid_or_expired_email_action" });
  const result = await document.send(new GetCommand({ TableName: tableName, Key: emailActionKey(tokenHash), ConsistentRead: true }));
  const item = actionFromItem(result.Item, purpose, Math.floor(Date.now() / 1000));
  return item === null ? response(400, { error: "invalid_or_expired_email_action" }) : { tokenHash, item };
}

type TransactionItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

function consumeEmailActionUpdate(tokenHash: string, item: Item, now: string): TransactionItem {
  return { Update: {
    TableName: tableName,
    Key: emailActionKey(tokenHash),
    UpdateExpression: "SET #status = :used, used_at = :now",
    ConditionExpression: "#status = :pending AND nonce = :nonce AND expires_at > :nowEpoch",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":used": "USED", ":pending": "PENDING", ":now": now, ":nonce": item.nonce,
      ":nowEpoch": Math.floor(Date.now() / 1000),
    },
  } };
}

export async function verifyEmail(event: Event): Promise<Response> {
  const found = await readEmailAction(event, "verify_email");
  if ("statusCode" in found) return found;
  const { item, tokenHash } = found;
  const email = String(item.email);
  const subject = String(item.subject);
  const credentialResult = await document.send(new GetCommand({ TableName: tableName, Key: credentialKey(email), ConsistentRead: true }));
  const credential = credentialResult.Item === undefined ? null : credentialFromItem(credentialResult.Item);
  if (credential?.subject !== subject) return response(400, { error: "invalid_or_expired_email_action" });
  const now = new Date().toISOString();
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName,
        Key: credentialKey(email),
        UpdateExpression: "SET email_verified = :verified, verified_at = :now REMOVE email_verification_nonce",
        ConditionExpression: "subject = :subject AND email_verification_nonce = :nonce",
        ExpressionAttributeValues: { ":verified": true, ":now": now, ":subject": subject, ":nonce": item.nonce },
      } },
      consumeEmailActionUpdate(tokenHash, item, now),
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      return response(400, { error: "invalid_or_expired_email_action" });
    }
    throw error;
  }
  return createLoginSession(passwordPrincipal(credential));
}

export async function requestPasswordReset(event: Event): Promise<Response> {
  const unavailable = emailActionsUnavailable();
  if (unavailable !== null) return unavailable;
  const email = normalizeEmail(objectBody(event)?.email);
  if (email === null) return response(202, { result: "accepted" });
  const credential = await passwordCredentials.find(email);
  if (!credential?.emailVerified) return response(202, { result: "accepted" });
  const action = await replaceEmailAction("reset_password", credential);
  await deliverEmailAction("reset_password", action, credential);
  return response(202, { result: "accepted" });
}

export async function revokePasswordLoginSessions(subject: string): Promise<void> {
  const sessions = await document.send(new QueryCommand({
    TableName: tableName,
    IndexName: "gsi1",
    KeyConditionExpression: "gsi1pk = :account",
    ExpressionAttributeValues: { ":account": `ACCOUNT#${passwordProviderId}#${subject}` },
  }));
  const now = new Date().toISOString();
  await Promise.all((sessions.Items ?? []).filter((item) => item.entity_type === "LOGIN_SESSION").map((item) => document.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: item.pk, sk: item.sk },
    UpdateExpression: "SET #status = :revoked, revoked_at = :now",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":revoked": "REVOKED", ":now": now },
  }))));
}

export async function resetPassword(event: Event): Promise<Response> {
  const parsed = objectBody(event);
  const passwordProblem = validatePassword(parsed?.password);
  if (passwordProblem !== null) return response(400, { error: `password_${passwordProblem}` });
  const found = await readEmailAction(event, "reset_password");
  if ("statusCode" in found) return found;
  const { item, tokenHash } = found;
  const email = String(item.email);
  const subject = String(item.subject);
  const passwordHash = await hashPassword(parsed!.password as string);
  const now = new Date().toISOString();
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName,
        Key: credentialKey(email),
        UpdateExpression: "SET password_hash = :hash, failed_sign_ins = :zero, locked_until = :none, password_changed_at = :now REMOVE password_reset_nonce",
        ConditionExpression: "subject = :subject AND email_verified = :verified AND password_reset_nonce = :nonce",
        ExpressionAttributeValues: {
          ":hash": passwordHash, ":zero": 0, ":none": null, ":now": now,
          ":subject": subject, ":verified": true, ":nonce": item.nonce,
        },
      } },
      consumeEmailActionUpdate(tokenHash, item, now),
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      return response(400, { error: "invalid_or_expired_email_action" });
    }
    throw error;
  }
  await revokePasswordLoginSessions(subject);
  return response(204, null);
}
