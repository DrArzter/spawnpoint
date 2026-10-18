import { normalizeEmail, validatePassword, normalizeDisplayName, hashPassword, verifyPassword } from "../../access/password-credential.ts";
import { accessInvitationTokenHash, accessInvitationUsable } from "../../access/access-invitations.ts";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { issueEmailAction } from "../../access/email-actions.ts";
import { type Identity } from "../../access/domain.ts";
import { passwordProviderId } from "../../access/password-login-provider.ts";
import { type Event, type Response, objectBody, response } from "./http.ts";
import { document, tableName } from "./access-store.ts";
import { accessInvitationKey } from "./access-invitations.ts";
import { passwordCredentialItem, passwordAccountItem, passwordCredentials, credentialKey } from "./credentials.ts";
import { emailActionItem, deliverEmailAction, revokePasswordLoginSessions } from "./email-actions.ts";
import { identityAccounts, accountKeyFor } from "./identity-store.ts";

type ValidPasswordInput = Readonly<{ email: string; displayName: string; password: string }>;

function validPasswordInput(event: Event): ValidPasswordInput | Response {
  const parsed = objectBody(event);
  if (parsed === null) return response(400, { error: "invalid_json" });
  const email = normalizeEmail(parsed.email);
  if (email === null) return response(400, { error: "invalid_email" });
  const passwordProblem = validatePassword(parsed.password);
  if (passwordProblem !== null) return response(400, { error: `password_${passwordProblem}` });
  const displayName = normalizeDisplayName(parsed.displayName);
  if (displayName === null) return response(400, { error: "invalid_display_name" });
  return { email, displayName, password: parsed.password as string };
}

// Registration creates an unlinked credential. Mailbox proof starts its first
// login session; only then is the account observed and eligible for the normal
// access-request flow.
export async function registerPassword(event: Event): Promise<Response> {
  const input = validPasswordInput(event);
  if ("statusCode" in input) return input;
  const invitationToken = objectBody(event)?.invitationToken;
  if (invitationToken !== undefined) {
    const tokenHash = accessInvitationTokenHash(invitationToken);
    if (tokenHash === null) return response(400, { error: "invalid_or_expired_invitation" });
    const invitation = await document.send(new GetCommand({ TableName: tableName, Key: accessInvitationKey(tokenHash), ConsistentRead: true }));
    if (!accessInvitationUsable(invitation.Item)) return response(400, { error: "invalid_or_expired_invitation" });
    if (invitation.Item?.delivery_email !== input.email) return response(403, { error: "invited_email_mismatch" });
  }
  const { email, displayName, password } = input;
  const subject = randomUUID();
  const action = issueEmailAction("verify_email");
  const credential = { subject, email, displayName };
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: passwordCredentialItem(subject, email, displayName, await hashPassword(password), action),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Put: {
        TableName: tableName,
        Item: emailActionItem("verify_email", action, credential),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") return response(409, { error: "email_already_registered" });
    throw error;
  }
  await deliverEmailAction("verify_email", action, credential, typeof invitationToken === "string" ? invitationToken : undefined);
  return response(202, { result: "verification_sent", email });
}

export async function linkPassword(identity: Identity, event: Event): Promise<Response> {
  const input = validPasswordInput(event);
  if ("statusCode" in input) return input;
  const existing = await identityAccounts(identity);
  if (existing.some((account) => account.platform === passwordProviderId)) {
    return response(409, { error: "password_account_already_linked" });
  }
  const { email, displayName, password } = input;
  const subject = randomUUID();
  const action = issueEmailAction("verify_email");
  const credential = { subject, email, displayName };
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: passwordCredentialItem(subject, email, displayName, await hashPassword(password), action),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Put: {
        TableName: tableName,
        Item: passwordAccountItem(subject, email, displayName, identity),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Put: {
        TableName: tableName,
        Item: {
          pk: `IDENTITY#${identity.id}`,
          sk: `LOGIN_PROVIDER#${passwordProviderId}`,
          entity_type: "IDENTITY_LOGIN_PROVIDER",
          provider: passwordProviderId,
          subject,
          created_at: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Put: {
        TableName: tableName,
        Item: emailActionItem("verify_email", action, credential, identity.id),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      return response(409, { error: "email_already_registered" });
    }
    throw error;
  }
  await deliverEmailAction("verify_email", action, credential);
  return response(202, { result: "verification_sent", email });
}

export async function changePassword(identity: Identity, event: Event): Promise<Response> {
  const parsed = objectBody(event);
  if (parsed === null) return response(400, { error: "invalid_json" });
  const email = normalizeEmail(parsed.email);
  if (email === null) return response(400, { error: "invalid_email" });
  if (typeof parsed.currentPassword !== "string") return response(400, { error: "current_password_required" });
  const passwordProblem = validatePassword(parsed.password);
  if (passwordProblem !== null) return response(400, { error: `password_${passwordProblem}` });
  const credential = await passwordCredentials.find(email);
  if (credential === null || !credential.emailVerified || !await verifyPassword(parsed.currentPassword, credential.passwordHash)) {
    return response(401, { error: "invalid_current_password" });
  }
  const linked = await document.send(new GetCommand({
    TableName: tableName,
    Key: { pk: accountKeyFor(passwordProviderId, credential.subject), sk: "ACCOUNT" },
    ConsistentRead: true,
  }));
  if (linked.Item?.identity_id !== identity.id) return response(403, { error: "credential_not_linked" });
  await document.send(new UpdateCommand({
    TableName: tableName,
    Key: credentialKey(email),
    UpdateExpression: "SET password_hash = :hash, failed_sign_ins = :zero, locked_until = :none, password_changed_at = :now",
    ConditionExpression: "subject = :subject AND email_verified = :verified",
    ExpressionAttributeValues: {
      ":hash": await hashPassword(parsed.password as string),
      ":zero": 0,
      ":none": null,
      ":now": new Date().toISOString(),
      ":subject": credential.subject,
      ":verified": true,
    },
  }));
  await revokePasswordLoginSessions(credential.subject);
  return response(204, null);
}
