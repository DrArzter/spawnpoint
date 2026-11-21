import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { confirmStartKeyboard } from "../keyboards/main-menu.ts";
import type { AccessStore } from "../services/access.ts";
import { startIsRunning, startSession } from "../services/aws.ts";
import { render, type RenderMode } from "../ui/render.ts";

export type SessionStarter = Readonly<{
  isRunning: () => Promise<boolean>;
  start: (requestedBy: string) => Promise<string>;
}>;

const awsSessions: SessionStarter = { isRunning: startIsRunning, start: startSession };

export async function requestStartCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  await render(ctx, replies.confirmStart(), confirmStartKeyboard(), mode);
}

export async function startCommand(
  ctx: Context,
  store: Pick<AccessStore, "identityId">,
  mode: RenderMode = "reply",
  sessions: SessionStarter = awsSessions,
): Promise<void> {
  if (await sessions.isRunning()) {
    await render(ctx, replies.alreadyRunning(), undefined, mode);
    return;
  }
  // The same pseudonymous id the panel sends (ADR-0006), so no Telegram id
  // enters the execution history, which cannot be deleted per person.
  const identityId = ctx.from === undefined ? null : await store.identityId(ctx.from.id);
  if (identityId === null) {
    await render(ctx, replies.denied(), undefined, mode);
    return;
  }
  const operationId = await sessions.start(`identity:${identityId}`);
  await render(ctx, replies.starting(operationId), undefined, mode);
}
