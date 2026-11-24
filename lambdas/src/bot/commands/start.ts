import type { Context } from "grammy";

import { CHAT_REQUEST_KIND, type ChatReply, type ChatRequest } from "../../../../contract/chat.ts";
import { replies } from "../../domain/telegram-bot.ts";
import { confirmStartKeyboard } from "../keyboards/main-menu.ts";
import { askApi } from "../services/aws-api.ts";
import { env } from "../services/aws.ts";
import { render, type RenderMode } from "../ui/render.ts";

export type StartOutcome =
  | Readonly<{ kind: "starting"; operationId: string }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "failed" }>;

export type WorldStarter = (telegramId: number) => Promise<StartOutcome>;

// Refusals that mean a session is running or about to change.
const BUSY = new Set(["host_already_running", "host_transitioning", "operation_in_progress", "session_transitioning"]);

/** What the API's start route answered, in the bot's words. */
export function startOutcome(reply: ChatReply): StartOutcome {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(reply.body) as Record<string, unknown>;
  } catch {
    // An empty or unreadable body carries no detail; the status still decides.
  }
  if (reply.statusCode === 202 && typeof body.operationId === "string") return { kind: "starting", operationId: body.operationId };
  if (reply.statusCode === 401 || reply.statusCode === 403) return { kind: "denied" };
  if (reply.statusCode === 409 && typeof body.error === "string" && BUSY.has(body.error)) return { kind: "busy" };
  return { kind: "failed" };
}

// The world the bot starts is deployment configuration: the bot has no world picker.
export function startRequest(telegramId: number, gameId: string, worldId: string): ChatRequest {
  return {
    kind: CHAT_REQUEST_KIND,
    account: { provider: "telegram", subject: String(telegramId) },
    routeKey: "POST /games/{gameId}/worlds/{worldId}/start",
    pathParameters: { gameId, worldId },
  };
}

const apiStarter: WorldStarter = async (telegramId) =>
  startOutcome(await askApi(startRequest(telegramId, env("GAME_ID"), env("WORLD_ID"))));

export async function requestStartCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  await render(ctx, replies.confirmStart(), confirmStartKeyboard(), mode);
}

function startReply(outcome: StartOutcome): string {
  switch (outcome.kind) {
    case "starting": return replies.starting(outcome.operationId);
    case "busy": return replies.alreadyRunning();
    case "denied": return replies.denied();
    case "failed": return replies.failure();
  }
}

export async function startCommand(ctx: Context, mode: RenderMode = "reply", start: WorldStarter = apiStarter): Promise<void> {
  const text = ctx.from === undefined ? replies.denied() : startReply(await start(ctx.from.id));
  await render(ctx, text, undefined, mode);
}
