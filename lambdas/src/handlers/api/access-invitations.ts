import { accessInvitationTokenHash, accessInvitationUsable, issueAccessInvitation, accessInvitationUrl, renderAccessInvitationEmail, renderAccessInvitationProofEmail } from "../../access/access-invitations.ts";
import { GetCommand, QueryCommand, PutCommand, UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type Identity } from "../../access/domain.ts";
import { normalizeEmail } from "../../access/password-credential.ts";
import { passwordProviderId } from "../../access/password-login-provider.ts";
import { issueEmailAction, emailActionTokenHash } from "../../access/email-actions.ts";
import { randomUUID } from "node:crypto";
import { type Caller, type Event, type Response, objectBody, response, parameter } from "./http.ts";
import { document, tableName } from "./access-store.ts";
import { emailDeliveryProvider, emailSender } from "./mail.ts";
import { panelUrl } from "./origins.ts";
import { observe, resolveIdentity, accountKey } from "./identity-store.ts";
import { type Item } from "./access-store.ts";
import { type EmailSender } from "../../email/email-sender.ts";

function invitationStatus(item: Item): unknown {
  if (accessInvitationUsable(item)) return "PENDING";
  return item.status === "PENDING" ? "EXPIRED" : item.status;
}

export function accessInvitationKey(tokenHash: string): Record<string, string> {
  return { pk: `ACCESS_INVITATION#${tokenHash}`, sk: "TOKEN" };
}

function accessInvitationProofKey(tokenHash: string, account: Caller): Record<string, string> {
  return { pk: `ACCESS_INVITATION#${tokenHash}`, sk: `PROOF#${account.provider}#${account.subject}` };
}

export async function checkAccessInvitation(event: Event): Promise<Response> {
  const tokenHash = accessInvitationTokenHash(objectBody(event)?.token);
  if (tokenHash === null) return response(200, { valid: false, email: null });
  const result = await document.send(new GetCommand({ TableName: tableName, Key: accessInvitationKey(tokenHash), ConsistentRead: true }));
  return response(200, { valid: accessInvitationUsable(result.Item), email: accessInvitationUsable(result.Item) ? result.Item!.delivery_email : null });
}

export async function accessInvitations(): Promise<Response> {
  const result = await document.send(new QueryCommand({
    TableName: tableName,
    IndexName: "gsi1",
    KeyConditionExpression: "gsi1pk = :invitations",
    ExpressionAttributeValues: { ":invitations": "ACCESS_INVITATION#CREATED" },
    ScanIndexForward: false,
    Limit: 50,
  }));
  return response(200, { invitations: (result.Items ?? []).map((item) => ({
    id: item.token_hash,
    status: invitationStatus(item),
    createdAt: item.created_at,
    expiresAt: new Date(Number(item.expires_at) * 1000).toISOString(),
    usedAt: item.used_at ?? null,
    delivery: item.delivery ?? "not_requested",
    deliveryEmail: item.delivery_email ?? null,
  })) });
}

export async function createAccessInvitation(identity: Identity, event: Event): Promise<Response> {
  const parsed = objectBody(event);
  if (parsed === null) return response(400, { error: "invalid_json" });
  const email = parsed.email === undefined ? null : normalizeEmail(parsed.email);
  if (emailDeliveryProvider === "none" && parsed.email !== undefined) return response(409, { error: "email_delivery_unavailable" });
  if (emailDeliveryProvider !== "none" && email === null) return response(400, { error: "invalid_email" });
  if (!panelUrl) return response(503, { error: "panel_url_unavailable" });
  const sender = email === null ? null : await emailSender();
  if (email !== null && sender === null) return response(409, { error: "email_delivery_unavailable" });
  const invitation = issueAccessInvitation();
  const createdAt = new Date().toISOString();
  const url = accessInvitationUrl(panelUrl, invitation.token);
  await document.send(new PutCommand({
    TableName: tableName,
    Item: {
      ...accessInvitationKey(invitation.tokenHash), entity_type: "ACCESS_INVITATION", token_hash: invitation.tokenHash,
      status: "PENDING", created_by: identity.id, created_at: createdAt,
      expires_at: invitation.expiresAtEpochSeconds, ttl: invitation.expiresAtEpochSeconds,
      delivery: email === null ? "not_requested" : "pending",
      ...(email === null ? {} : { delivery_email: email }),
      gsi1pk: "ACCESS_INVITATION#CREATED", gsi1sk: `${createdAt}#${invitation.tokenHash}`,
    },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  const delivery = await deliverAccessInvitation(sender, email, identity.displayName, url, invitation.tokenHash);
  return response(201, { id: invitation.tokenHash, url, createdAt, expiresAt: new Date(invitation.expiresAtEpochSeconds * 1000).toISOString(), delivery });
}

async function deliverAccessInvitation(sender: EmailSender | null, email: string | null, inviterName: string, url: string, tokenHash: string): Promise<"not_requested" | "sent" | "failed"> {
  if (email === null || sender === null) return "not_requested";
  let delivery: "sent" | "failed" = "sent";
  try {
    await sender.send(renderAccessInvitationEmail({ email, inviterName, url, tokenHash }));
  } catch (error) {
    delivery = "failed";
    console.error("access_invitation_email_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
  }
  await document.send(new UpdateCommand({
    TableName: tableName, Key: accessInvitationKey(tokenHash),
    UpdateExpression: "SET delivery = :delivery",
    ExpressionAttributeValues: { ":delivery": delivery },
  }));
  return delivery;
}

export async function revokeAccessInvitation(event: Event): Promise<Response> {
  const tokenHash = parameter(event, "invitationId");
  if (!/^[A-Za-z0-9_-]{43}$/.test(tokenHash)) return response(400, { error: "invalid_invitation_id" });
  try {
    await document.send(new UpdateCommand({
      TableName: tableName, Key: accessInvitationKey(tokenHash),
      UpdateExpression: "SET #status = :revoked, revoked_at = :now",
      ConditionExpression: "#status = :pending AND expires_at > :nowEpoch",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":revoked": "REVOKED", ":pending": "PENDING", ":now": new Date().toISOString(), ":nowEpoch": Math.floor(Date.now() / 1000) },
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return response(409, { error: "invitation_unavailable" });
    throw error;
  }
  return response(204, null);
}

export async function requestAccessInvitationProof(account: Caller, event: Event): Promise<Response> {
  const token = objectBody(event)?.token;
  const tokenHash = accessInvitationTokenHash(token);
  if (tokenHash === null) return response(400, { error: "invalid_or_expired_invitation" });
  if (account.provider === passwordProviderId) return response(409, { error: "use_verified_account_email" });
  const observed = await observe(account);
  if (await resolveIdentity(account, observed) !== null) return response(409, { error: "already_member" });
  const found = await document.send(new GetCommand({ TableName: tableName, Key: accessInvitationKey(tokenHash), ConsistentRead: true }));
  if (!accessInvitationUsable(found.Item) || typeof found.Item?.delivery_email !== "string") return response(400, { error: "invalid_or_expired_invitation" });
  const sender = await emailSender();
  if (sender === null) return response(503, { error: "email_delivery_unavailable" });
  const proof = issueEmailAction("verify_email");
  const nowEpoch = Math.floor(Date.now() / 1000);
  try {
    await document.send(new PutCommand({
      TableName: tableName,
      Item: {
        ...accessInvitationProofKey(tokenHash, account), entity_type: "ACCESS_INVITATION_PROOF",
        proof_hash: proof.tokenHash, status: "PENDING", expires_at: proof.expiresAtEpochSeconds,
        sent_at_epoch: nowEpoch, ttl: proof.expiresAtEpochSeconds,
      },
      ConditionExpression: "attribute_not_exists(pk) OR sent_at_epoch < :cutoff",
      ExpressionAttributeValues: { ":cutoff": nowEpoch - 60 },
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return response(429, { error: "proof_recently_sent" });
    throw error;
  }
  const url = `${panelUrl.replace(/\/$/, "")}/#/join?token=${encodeURIComponent(token as string)}&proof=${encodeURIComponent(proof.token)}`;
  await sender.send(renderAccessInvitationProofEmail({ email: found.Item.delivery_email, url, proofHash: proof.tokenHash }));
  return response(202, { result: "proof_sent" });
}

type InvitationProof = Readonly<{ proofHash: string | null; error: Response | null }>;

async function invitationProof(account: Caller, invitedEmail: unknown, suppliedProof: unknown, tokenHash: string): Promise<InvitationProof> {
  const rejected = (status: number, error: string): InvitationProof => ({ proofHash: null, error: response(status, { error }) });
  if (invitedEmail !== undefined && typeof invitedEmail !== "string") return rejected(400, "invalid_or_expired_invitation");
  const emailBound = typeof invitedEmail === "string";
  const passwordAccount = account.provider === passwordProviderId;
  if (emailBound && passwordAccount && account.email !== invitedEmail) return rejected(403, "invited_email_mismatch");
  if (!emailBound || passwordAccount) return { proofHash: null, error: null };
  const proofHash = emailActionTokenHash(typeof suppliedProof === "string" ? suppliedProof : "");
  if (proofHash === null) return rejected(403, "invited_email_verification_required");
  const proof = await document.send(new GetCommand({ TableName: tableName, Key: accessInvitationProofKey(tokenHash, account), ConsistentRead: true }));
  if (proof.Item?.proof_hash !== proofHash || proof.Item?.status !== "PENDING" || Number(proof.Item?.expires_at) <= Math.floor(Date.now() / 1000)) {
    return rejected(403, "invalid_or_expired_invitation_proof");
  }
  return { proofHash, error: null };
}

export async function redeemAccessInvitation(account: Caller, event: Event): Promise<Response> {
  const parsed = objectBody(event);
  const tokenHash = accessInvitationTokenHash(parsed?.token);
  if (tokenHash === null) return response(400, { error: "invalid_or_expired_invitation" });
  const observed = await observe(account);
  if (await resolveIdentity(account, observed) !== null) return response(409, { error: "already_member" });
  const found = await document.send(new GetCommand({ TableName: tableName, Key: accessInvitationKey(tokenHash), ConsistentRead: true }));
  if (!accessInvitationUsable(found.Item)) return response(400, { error: "invalid_or_expired_invitation" });
  const proof = await invitationProof(account, found.Item?.delivery_email, parsed?.proof, tokenHash);
  if (proof.error !== null) return proof.error;
  const { proofHash } = proof;
  const identityId = randomUUID();
  const now = new Date().toISOString();
  const name = account.displayName;
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName, Key: accessInvitationKey(tokenHash),
        UpdateExpression: "SET #status = :used, used_at = :now, identity_id = :identityId",
        ConditionExpression: "#status = :pending AND expires_at > :nowEpoch",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":used": "USED", ":pending": "PENDING", ":now": now, ":identityId": identityId, ":nowEpoch": Math.floor(Date.now() / 1000) },
      } },
      ...(proofHash !== null ? [{ Update: {
        TableName: tableName, Key: accessInvitationProofKey(tokenHash, account),
        UpdateExpression: "SET #status = :used, used_at = :now",
        ConditionExpression: "#status = :pending AND proof_hash = :proofHash AND expires_at > :nowEpoch",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":used": "USED", ":pending": "PENDING", ":proofHash": proofHash, ":now": now, ":nowEpoch": Math.floor(Date.now() / 1000) },
      } }] : []),
      { Put: { TableName: tableName, Item: {
        pk: `IDENTITY#${identityId}`, sk: "PROFILE", identity_id: identityId, display_name: name,
        role_id: "viewer", direct_grants: [], status: "ACTIVE", created_at: now,
        created_by: found.Item!.created_by, gsi1pk: "IDENTITY#ACTIVE", gsi1sk: name.toLowerCase(),
      }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: {
        TableName: tableName, Key: { pk: accountKey(account), sk: "ACCOUNT" },
        UpdateExpression: "SET identity_id = :identityId, #status = :approved, gsi1pk = :linked, gsi1sk = :now, approved_at = :now, approved_by = :by",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":identityId": identityId, ":approved": "APPROVED", ":linked": `IDENTITY#${identityId}`, ":now": now, ":by": found.Item!.created_by },
      } },
      { Put: { TableName: tableName, Item: {
        pk: `IDENTITY#${identityId}`, sk: `LOGIN_PROVIDER#${account.provider}`,
        entity_type: "IDENTITY_LOGIN_PROVIDER", provider: account.provider,
        subject: account.subject, created_at: now,
      }, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") return response(409, { error: "invitation_unavailable" });
    throw error;
  }
  return response(201, { identity: { id: identityId, displayName: name, roleId: "viewer", directGrants: [] } });
}
