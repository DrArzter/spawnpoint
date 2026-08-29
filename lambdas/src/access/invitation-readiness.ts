export type InvitationDeliveryReadiness = "ready" | "notifications_off" | "bot_unavailable";

type Item = Record<string, unknown>;

export function directInvitationReadiness(subscriptionItem: Item | undefined, accounts: readonly Item[]): InvitationDeliveryReadiness {
  const subscriptions = subscriptionItem?.subscriptions;
  if (subscriptions === null || typeof subscriptions !== "object" || (subscriptions as Record<string, unknown>)["invitation.direct"] !== true) {
    return "notifications_off";
  }
  return accounts.some(hasPrivateTelegramChat) ? "ready" : "bot_unavailable";
}

function hasPrivateTelegramChat(item: Item): boolean {
  if (item.platform !== "telegram") return false;
  const raw = item.direct_chat_id ?? item.chat_id;
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
