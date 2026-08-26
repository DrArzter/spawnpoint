// The allow-list gate. Commands and inline-button callbacks are operational;
// ordinary chat is ignored without making the bot scold every stranger.

import type { Context, NextFunction } from "grammy";

import { isAuthorized, parseAllowList, replies } from "../../domain/telegram-bot.ts";

export type AllowListSource = () => Promise<string>;

export function authMiddleware(allowListSource: AllowListSource) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const isCommand = ctx.has("message:entities:bot_command");
    const isCallback = ctx.callbackQuery !== undefined;
    if (!isCommand && !isCallback) return next();
    const userId = ctx.from?.id;
    if (userId === undefined) return;

    const allowList = parseAllowList(await allowListSource());
    if (!isAuthorized(userId, allowList)) {
      if (isCallback) {
        await ctx.answerCallbackQuery({ text: replies.denied(), show_alert: true });
      } else {
        await ctx.reply(replies.denied());
      }
      return;
    }
    return next();
  };
}
