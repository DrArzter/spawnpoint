// Composition root: middleware order and command registry. grammY owns
// parsing and routing (including /command@BotName); decisions stay in the
// domain module, AWS verbs in services.

import { Bot } from "grammy";

import { replies } from "../domain/telegram-bot.ts";
import { addressCommand, networkCommand } from "./commands/info.ts";
import { packCommand } from "./commands/pack.ts";
import { requestStartCommand, startCommand } from "./commands/start.ts";
import { statusCommand } from "./commands/status.ts";
import { welcomeCommand } from "./commands/welcome.ts";
import { callbacks, mainMenuKeyboard } from "./keyboards/main-menu.ts";
import { authMiddleware, type AllowListSource } from "./middleware/auth.ts";

export function buildBot(token: string, allowListSource: AllowListSource): Bot {
  const bot = new Bot(token);

  bot.use(authMiddleware(allowListSource));
  bot.command("start", welcomeCommand);
  bot.command("server_start", requestStartCommand);
  bot.command("status", statusCommand);
  bot.command("address", addressCommand);
  bot.command("network", networkCommand);
  bot.command("help", welcomeCommand);
  bot.command("pack", packCommand);

  bot.callbackQuery(callbacks.menu, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(replies.welcome(), { reply_markup: mainMenuKeyboard() });
  });
  bot.callbackQuery(callbacks.status, async (ctx) => {
    await ctx.answerCallbackQuery();
    await statusCommand(ctx);
  });
  bot.callbackQuery(callbacks.address, async (ctx) => {
    await ctx.answerCallbackQuery();
    await addressCommand(ctx);
  });
  bot.callbackQuery(callbacks.network, async (ctx) => {
    await ctx.answerCallbackQuery();
    await networkCommand(ctx);
  });
  bot.callbackQuery(callbacks.pack, async (ctx) => {
    await ctx.answerCallbackQuery();
    await packCommand(ctx);
  });
  bot.callbackQuery(callbacks.requestStart, async (ctx) => {
    await ctx.answerCallbackQuery();
    await requestStartCommand(ctx);
  });
  bot.callbackQuery(callbacks.confirmStart, async (ctx) => {
    await ctx.answerCallbackQuery();
    await startCommand(ctx);
  });
  // Reached only when no command above matched: an authorised user typing
  // an unknown command gets the menu, not silence.
  bot.on("message:entities:bot_command", (ctx) =>
    ctx.reply(replies.unknown(), { reply_markup: mainMenuKeyboard() }),
  );

  // Swallow and log: an unhandled error would bubble into a non-200, and
  // Telegram redelivers non-200 updates until they poison the webhook.
  bot.catch((error) => {
    console.error("update failed", error.message, error.error);
    error.ctx.reply(replies.failure()).catch(() => undefined);
  });

  return bot;
}
