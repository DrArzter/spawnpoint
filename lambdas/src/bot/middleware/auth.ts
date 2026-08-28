// The allow-list gate. Commands and inline-button callbacks are operational;
// ordinary chat is ignored without making the bot scold every stranger.

import type { Context, NextFunction } from "grammy";

import { isAuthorized, parseAllowList, replies } from "../../domain/telegram-bot.ts";

export type AllowListSource = () => Promise<string>;

export type SpawnpointAccessContext = Context & {
  spawnpointAccess?: Readonly<{ authorized: boolean }>;
};

type PublicInteractions = Readonly<{
  commands: ReadonlySet<string>;
  callbacks: ReadonlySet<string>;
}>;

function commandName(ctx: Context): string | null {
  const message = ctx.message;
  const entity = message?.entities?.find((candidate) => candidate.type === "bot_command" && candidate.offset === 0);
  if (message?.text === undefined || entity === undefined) return null;
  return message.text.slice(1, entity.length).split("@")[0]?.toLowerCase() ?? null;
}

export function contextIsAuthorized(ctx: Context): boolean {
  return (ctx as SpawnpointAccessContext).spawnpointAccess?.authorized === true;
}

export function authMiddleware(allowListSource: AllowListSource, publicInteractions: PublicInteractions) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const isCommand = ctx.has("message:entities:bot_command");
    const isCallback = ctx.callbackQuery !== undefined;
    if (!isCommand && !isCallback) return next();
    const userId = ctx.from?.id;
    if (userId === undefined) return;

    const allowList = parseAllowList(await allowListSource());
    const authorized = isAuthorized(userId, allowList);
    (ctx as SpawnpointAccessContext).spawnpointAccess = { authorized };
    const publicCommand = commandName(ctx);
    const isPublic = publicCommand !== null
      ? publicInteractions.commands.has(publicCommand)
      : ctx.callbackQuery?.data !== undefined && publicInteractions.callbacks.has(ctx.callbackQuery.data);
    if (!authorized && !isPublic) {
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
