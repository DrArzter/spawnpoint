import type { Context, NextFunction } from "grammy";

import type { AccessStore, TelegramContact } from "../services/access.ts";

export function telegramContact(ctx: Context): TelegramContact | null {
  if (ctx.chat?.type !== "private" || ctx.from === undefined) return null;
  const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ").trim();
  return {
    id: ctx.from.id,
    chatId: ctx.chat.id,
    displayName: displayName || ctx.from.username || String(ctx.from.id),
    ...(ctx.from.username === undefined ? {} : { username: ctx.from.username }),
  };
}

export function observeContacts(store: AccessStore) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const contact = telegramContact(ctx);
    if (contact !== null) {
      try {
        await store.observe(contact);
      } catch (error) {
        console.error("failed to observe Telegram contact", error);
      }
    }
    return next();
  };
}
