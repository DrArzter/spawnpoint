export type AccessApprovedEvent = Readonly<{
  telegramChatId: number;
  identityId: string;
  displayName: string;
  roleName: string;
}>;

export function privateTelegramChatId(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseAccessApprovedEvent(value: unknown): AccessApprovedEvent | null {
  if (value === null || typeof value !== "object") return null;
  const detail = value as Record<string, unknown>;
  const telegramChatId = privateTelegramChatId(detail.telegramChatId);
  const identityId = text(detail.identityId);
  const displayName = text(detail.displayName);
  const roleName = text(detail.roleName);
  return telegramChatId === null || identityId === null || displayName === null || roleName === null
    ? null
    : { telegramChatId, identityId, displayName, roleName };
}

export function renderAccessApproved(event: AccessApprovedEvent): string {
  return [
    "Spawnpoint access approved",
    "",
    `${event.displayName}, your access request was approved with the ${event.roleName} role.`,
    "Open the control panel to see what this role allows and choose your notification subscriptions.",
  ].join("\n");
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 200 ? normalized : null;
}
