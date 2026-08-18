import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { startIsRunning, startSession } from "../services/aws.ts";

export async function startCommand(ctx: Context): Promise<void> {
  if (await startIsRunning()) {
    await ctx.reply(replies.alreadyRunning());
    return;
  }
  // Attribution over identity theatre: a stable, PII-minimal id (ADR-0006).
  const operationId = await startSession(`telegram:${ctx.from?.id}`);
  await ctx.reply(replies.starting(operationId));
}
