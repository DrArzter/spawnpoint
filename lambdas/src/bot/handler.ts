// Lambda entry: cold-start wiring only. grammY's aws-lambda-async adapter
// handles the Function URL event, and its secretToken option enforces the
// webhook secret registered at setWebhook — requests without it get a 401
// before any handler runs. Telegram itself always sends the token, so the
// retry-storm concern applies only to handler errors, which bot.catch absorbs.

import { webhookCallback } from "grammy";

import { buildBot } from "./bot.ts";
import { accessStore } from "./services/access.ts";
import { env, parameter } from "./services/aws.ts";

const ALLOW_LIST_TTL_SECONDS = 60;

async function build() {
  const token = await parameter(env("BOT_TOKEN_PARAMETER"));
  const secret = await parameter(env("WEBHOOK_SECRET_PARAMETER"));
  const bot = buildBot(token, () => parameter(env("ALLOW_LIST_PARAMETER"), ALLOW_LIST_TTL_SECONDS), accessStore);
  await bot.init();
  return webhookCallback(bot, "aws-lambda-async", {
    secretToken: secret,
    timeoutMilliseconds: 15_000,
  });
}

// One bot per container; a failed cold start is retried on the next invoke.
let callbackPromise: ReturnType<typeof build> | undefined;

type FunctionUrlEvent = {
  body?: string;
  headers: Record<string, string | undefined>;
};

export async function handler(event: FunctionUrlEvent, context: unknown): Promise<unknown> {
  callbackPromise ??= build();
  let callback: Awaited<ReturnType<typeof build>>;
  try {
    callback = await callbackPromise;
  } catch (error) {
    callbackPromise = undefined;
    throw error;
  }
  return callback(event, context);
}
