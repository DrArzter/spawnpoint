import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { visitorMenuKeyboard } from "../keyboards/main-menu.ts";
import { telegramContact } from "../middleware/contact.ts";
import type { AccessStore } from "../services/access.ts";
import { render, type RenderMode } from "../ui/render.ts";

export async function requestAccessCommand(
  ctx: Context,
  store: AccessStore,
  mode: RenderMode = "reply",
): Promise<void> {
  const contact = telegramContact(ctx);
  if (contact === null) {
    await ctx.reply(replies.requestAccessInPrivate());
    return;
  }
  await store.request(contact);
  await render(ctx, replies.accessRequested(), visitorMenuKeyboard(), mode);
}
