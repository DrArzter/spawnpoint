// The allow-list gate. Only command messages are gated: gating everything
// would make the bot answer strangers' ordinary chatter with denials.

import type { Context, NextFunction } from "grammy";

import { isAuthorized, parseAllowList, replies } from "../../domain/telegram-bot.ts";

export type AllowListSource = () => Promise<string>;

export function authMiddleware(allowListSource: AllowListSource) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    if (!ctx.has("message:entities:bot_command")) return next();
    const userId = ctx.from?.id;
    if (userId === undefined) return;

    const allowList = parseAllowList(await allowListSource());
    if (!isAuthorized(userId, allowList)) {
      await ctx.reply(replies.denied());
      return;
    }
    return next();
  };
}
