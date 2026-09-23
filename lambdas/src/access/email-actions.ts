import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { TransactionalEmail } from "../email/email-sender.ts";
import { renderEmailHtml } from "../email/layout.ts";

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

function actionUrl(panelUrl: string, purpose: EmailActionPurpose, token: string, invitationToken?: string): string {
  const route = purpose === "verify_email" ? "verify-email" : "reset-password";
  const parameters = new URLSearchParams({ token });
  if (purpose === "verify_email" && invitationToken) parameters.set("invite", invitationToken);
  return `${panelUrl.replace(/\/$/, "")}/#/${route}?${parameters.toString()}`;
}

export function renderEmailAction(
  purpose: EmailActionPurpose,
  input: Readonly<{ email: string; displayName: string; panelUrl: string; action: EmailAction; invitationToken?: string }>,
): TransactionalEmail {
  const url = actionUrl(input.panelUrl, purpose, input.action.token, input.invitationToken);
  const verification = purpose === "verify_email";
  const subject = verification ? "Verify your Spawnpoint email" : "Reset your Spawnpoint password";
  const title = verification ? "Verify your email" : "Reset your password";
  const instruction = verification
    ? "Confirm this email address to finish creating or linking your Spawnpoint sign-in."
    : "Use this link to choose a new Spawnpoint password.";
  const expiry = verification ? "24 hours" : "1 hour";
  const actionLabel = verification ? "Verify email" : "Reset password";
  const greeting = `Hi ${input.displayName},`;
  const note = `This link expires in ${expiry}. If you did not request it, you can ignore this email — nothing changes until the link is opened.`;
  return {
    to: input.email,
    subject,
    // The plain text says everything the HTML does, in the same order, for the
    // client that shows nothing else.
    text: `${greeting}\n\n${instruction}\n\n${actionLabel}: ${url}\n\n${note}`,
    html: renderEmailHtml({
      panelUrl: input.panelUrl,
      title,
      greeting,
      paragraphs: [instruction],
      action: { label: actionLabel, url },
      note,
    }),
    idempotencyKey: `${purpose}/${input.action.nonce}`,
    tags: [{ name: "category", value: purpose }],
  };
}
