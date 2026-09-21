export type InvitationAudience = "broadcast" | "direct";
export type InvitationDeliveryStatus = "DELIVERED" | "PARTIAL" | "FAILED" | "NO_RECIPIENTS";

export type InvitationEvent = Readonly<{
  invitationId: string;
  audience: InvitationAudience;
  gameId: string;
  gameName: string;
  worldId: string;
  worldName: string;
  senderIdentityId: string;
  senderDisplayName: string;
  recipientIdentityIds: readonly string[];
}>;

export function parseInvitationEvent(value: unknown): InvitationEvent | null {
  if (value === null || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const audience = item.audience;
  const recipients = item.recipientIdentityIds;
  if (
    (audience !== "broadcast" && audience !== "direct")
    || !Array.isArray(recipients)
    || !recipients.every((id) => typeof id === "string")
  ) return null;
  const required = ["invitationId", "gameId", "gameName", "worldId", "worldName", "senderIdentityId", "senderDisplayName"] as const;
  if (required.some((key) => typeof item[key] !== "string" || item[key] === "")) return null;
  return {
    invitationId: item.invitationId as string,
    audience,
    gameId: item.gameId as string,
    gameName: item.gameName as string,
    worldId: item.worldId as string,
    worldName: item.worldName as string,
    senderIdentityId: item.senderIdentityId as string,
    senderDisplayName: item.senderDisplayName as string,
    recipientIdentityIds: [...new Set(recipients as string[])],
  };
}

export function renderInvitation(event: InvitationEvent): string {
  const target = event.audience === "broadcast" ? "everyone" : "you";
  return `[INVITE] ${event.senderDisplayName} invited ${target} to play ${event.gameName} — ${event.worldName}.`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderInvitationEmail(event: InvitationEvent, panelUrl: string): Readonly<{
  subject: string;
  text: string;
  html: string;
}> {
  const subject = `${event.senderDisplayName} invited you to ${event.gameName}`;
  const text = `${renderInvitation({ ...event, audience: "direct" })}\n\nOpen Spawnpoint: ${panelUrl}`;
  const safeUrl = escapeHtml(panelUrl);
  return {
    subject,
    text,
    html: [
      `<p><strong>${escapeHtml(event.senderDisplayName)}</strong> invited you to play `,
      `<strong>${escapeHtml(event.gameName)} — ${escapeHtml(event.worldName)}</strong>.</p>`,
      `<p><a href="${safeUrl}">Open Spawnpoint</a></p>`,
    ].join(""),
  };
}

export function invitationDeliveryStatus(targetCount: number, successCount: number): InvitationDeliveryStatus {
  if (targetCount === 0) return "NO_RECIPIENTS";
  if (successCount === targetCount) return "DELIVERED";
  if (successCount === 0) return "FAILED";
  return "PARTIAL";
}
