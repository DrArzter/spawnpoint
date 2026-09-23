import { createHash, randomBytes } from "node:crypto";

import type { TransactionalEmail } from "../email/email-sender.ts";

export const accessInvitationLifetimeSeconds = 7 * 24 * 60 * 60;

export type IssuedAccessInvitation = Readonly<{
  token: string;
  tokenHash: string;
  expiresAtEpochSeconds: number;
}>;

export function accessInvitationTokenHash(token: unknown): string | null {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return createHash("sha256").update(token).digest("base64url");
}

export function issueAccessInvitation(nowEpochSeconds = Math.floor(Date.now() / 1000)): IssuedAccessInvitation {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: accessInvitationTokenHash(token)!,
    expiresAtEpochSeconds: nowEpochSeconds + accessInvitationLifetimeSeconds,
  };
}

export function accessInvitationUrl(panelUrl: string, token: string): string {
  if (accessInvitationTokenHash(token) === null) throw new Error("invalid access invitation token");
  return `${panelUrl.replace(/\/$/, "")}/#/join?token=${encodeURIComponent(token)}`;
}

export function accessInvitationUsable(
  item: Readonly<Record<string, unknown>> | undefined,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return item?.entity_type === "ACCESS_INVITATION"
    && item.status === "PENDING"
    && typeof item.expires_at === "number"
    && item.expires_at > nowEpochSeconds;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderAccessInvitationEmail(input: Readonly<{
  email: string;
  inviterName: string;
  url: string;
  tokenHash: string;
}>): TransactionalEmail {
  const intro = `${input.inviterName} invited ${input.email} to join Spawnpoint.`;
  const instruction = "Open this one-time link within 7 days, then choose how you want to sign in. You will need to verify this email address before joining.";
  return {
    to: input.email,
    subject: "Join Spawnpoint",
    text: `${intro}\n\n${instruction}\n\n${input.url}\n\nIf you were not expecting this invitation, you can ignore it.`,
    html: `<p>${escapeHtml(intro)}</p><p>${escapeHtml(instruction)}</p><p><a href="${escapeHtml(input.url)}">Join Spawnpoint</a></p><p>If you were not expecting this invitation, you can ignore it.</p>`,
    idempotencyKey: `access-invitation/${input.tokenHash}`,
    tags: [{ name: "category", value: "access_invitation" }],
  };
}

export function renderAccessInvitationProofEmail(input: Readonly<{ email: string; url: string; proofHash: string }>): TransactionalEmail {
  return {
    to: input.email,
    subject: "Confirm your Spawnpoint invitation",
    text: `Confirm that ${input.email} is yours to finish joining Spawnpoint:\n\n${input.url}\n\nThis link expires in 24 hours. If you did not request it, you can ignore this email.`,
    html: `<p>Confirm that ${escapeHtml(input.email)} is yours to finish joining Spawnpoint.</p><p><a href="${escapeHtml(input.url)}">Confirm email</a></p><p>This link expires in 24 hours. If you did not request it, you can ignore this email.</p>`,
    idempotencyKey: `access-invitation-proof/${input.proofHash}`,
    tags: [{ name: "category", value: "access_invitation_proof" }],
  };
}
