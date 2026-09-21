import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { TransactionalEmail } from "../email/email-sender.ts";

export type EmailActionPurpose = "verify_email" | "reset_password";

export type EmailAction = Readonly<{
  token: string;
  tokenHash: string;
  nonce: string;
  expiresAtEpochSeconds: number;
}>;

export const emailVerificationLifetimeSeconds = 24 * 60 * 60;
export const passwordResetLifetimeSeconds = 60 * 60;

export function emailActionTokenHash(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return createHash("sha256").update(token).digest("base64url");
}

export function issueEmailAction(
  purpose: EmailActionPurpose,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): EmailAction {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: emailActionTokenHash(token)!,
    nonce: randomUUID(),
    expiresAtEpochSeconds: nowEpochSeconds + (
      purpose === "verify_email" ? emailVerificationLifetimeSeconds : passwordResetLifetimeSeconds
    ),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function actionUrl(panelUrl: string, purpose: EmailActionPurpose, token: string): string {
  const route = purpose === "verify_email" ? "verify-email" : "reset-password";
  return `${panelUrl.replace(/\/$/, "")}/#/${route}?token=${encodeURIComponent(token)}`;
}

export function renderEmailAction(
  purpose: EmailActionPurpose,
  input: Readonly<{ email: string; displayName: string; panelUrl: string; action: EmailAction }>,
): TransactionalEmail {
  const url = actionUrl(input.panelUrl, purpose, input.action.token);
  const verification = purpose === "verify_email";
  const subject = verification ? "Verify your Spawnpoint email" : "Reset your Spawnpoint password";
  const instruction = verification
    ? "Confirm this email address to finish creating or linking your Spawnpoint sign-in."
    : "Use this link to choose a new Spawnpoint password.";
  const expiry = verification ? "24 hours" : "1 hour";
  const actionLabel = verification ? "Verify email" : "Reset password";
  return {
    to: input.email,
    subject,
    text: `Hi ${input.displayName},\n\n${instruction}\n\n${url}\n\nThis link expires in ${expiry}. If you did not request it, you can ignore this email.`,
    html: [
      `<p>Hi ${escapeHtml(input.displayName)},</p>`,
      `<p>${escapeHtml(instruction)}</p>`,
      `<p><a href="${escapeHtml(url)}">${actionLabel}</a></p>`,
      `<p>This link expires in ${expiry}. If you did not request it, you can ignore this email.</p>`,
    ].join(""),
    idempotencyKey: `${purpose}/${input.action.nonce}`,
    tags: [{ name: "category", value: purpose }],
  };
}
