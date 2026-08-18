// Composition root: middleware order and command registry. grammY owns
// parsing and routing (including /command@BotName); decisions stay in the
// domain module, AWS verbs in services.

import { Bot } from "grammy";

import { replies } from "../domain/telegram-bot.ts";
import { packCommand } from "./commands/pack.ts";
import { startCommand } from "./commands/start.ts";
import { statusCommand } from "./commands/status.ts";
import { authMiddleware, type AllowListSource } from "./middleware/auth.ts";

export function buildBot(token: string, allowListSource: AllowListSource): Bot {
  const bot = new Bot(token);

  bot.use(authMiddleware(allowListSource));
  bot.command("start", startCommand);
  bot.command("status", statusCommand);
  bot.command("pack", packCommand);
  // Reached only when no command above matched: an authorised user typing
  // an unknown command gets the menu, not silence.
  bot.on("message:entities:bot_command", (ctx) => ctx.reply(replies.unknown()));

  // Swallow and log: an unhandled error would bubble into a non-200, and
  // Telegram redelivers non-200 updates until they poison the webhook.
  bot.catch((error) => {
    console.error("update failed", error.message, error.error);
    error.ctx.reply(replies.failure()).catch(() => undefined);
  });

  return bot;
}
