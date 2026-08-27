import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { confirmStartKeyboard } from "../keyboards/main-menu.ts";
import { startIsRunning, startSession } from "../services/aws.ts";
import { render, type RenderMode } from "../ui/render.ts";

export async function requestStartCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  await render(ctx, replies.confirmStart(), confirmStartKeyboard(), mode);
}

export async function startCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  if (await startIsRunning()) {
    await render(ctx, replies.alreadyRunning(), undefined, mode);
    return;
  }
  // Attribution over identity theatre: a stable, PII-minimal id (ADR-0006).
  const operationId = await startSession(`telegram:${ctx.from?.id}`);
  await render(ctx, replies.starting(operationId), undefined, mode);
}
