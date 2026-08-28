import type { Context, NextFunction } from "grammy";

import type { Permission } from "../../access/domain.ts";
import { replies } from "../../domain/telegram-bot.ts";

export type SpawnpointAccessContext = Context & {
  spawnpointAccess?: Readonly<{ authorized: boolean }>;
};

type InteractionPermissions = Readonly<{
  publicCommands: ReadonlySet<string>;
  publicCallbacks: ReadonlySet<string>;
  commands: ReadonlyMap<string, Permission>;
  callbacks: ReadonlyMap<string, Permission>;
}>;

export type PermissionResolver = (telegramId: number, permission: Permission) => Promise<boolean>;

function commandName(ctx: Context): string | null {
  const message = ctx.message;
  const entity = message?.entities?.find((candidate) => candidate.type === "bot_command" && candidate.offset === 0);
  if (message?.text === undefined || entity === undefined) return null;
  return message.text.slice(1, entity.length).split("@")[0]?.toLowerCase() ?? null;
}

export function contextIsAuthorized(ctx: Context): boolean {
  return (ctx as SpawnpointAccessContext).spawnpointAccess?.authorized === true;
}

export function authMiddleware(resolvePermission: PermissionResolver, interactions: InteractionPermissions) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const isCommand = ctx.has("message:entities:bot_command");
    const isCallback = ctx.callbackQuery !== undefined;
    if (!isCommand && !isCallback) return next();
    const userId = ctx.from?.id;
    if (userId === undefined) return;

    const command = commandName(ctx);
    const callback = ctx.callbackQuery?.data;
    const isPublic = command !== null
      ? interactions.publicCommands.has(command)
      : callback !== undefined && interactions.publicCallbacks.has(callback);
    if (isPublic) {
      const authorized = await resolvePermission(userId, "status.read");
      (ctx as SpawnpointAccessContext).spawnpointAccess = { authorized };
      return next();
    }

    const permission = command !== null
      ? interactions.commands.get(command) ?? "status.read"
      : callback === undefined ? "status.read" : interactions.callbacks.get(callback) ?? "status.read";
    const authorized = await resolvePermission(userId, permission);
    (ctx as SpawnpointAccessContext).spawnpointAccess = { authorized };
    if (!authorized) {
      if (isCallback) await ctx.answerCallbackQuery({ text: replies.denied(), show_alert: true });
      else await ctx.reply(replies.denied());
      return;
    }
    return next();
  };
}
