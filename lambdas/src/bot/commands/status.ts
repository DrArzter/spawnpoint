import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { env, instanceState, readPointer } from "../services/aws.ts";

export async function statusCommand(ctx: Context): Promise<void> {
  const [state, pointer] = await Promise.all([instanceState(), readPointer()]);
  await ctx.reply(
    replies.status({
      instanceState: state,
      desiredRelease: pointer?.desired_release ?? null,
      activeRelease: pointer?.active_release ?? null,
      connectionAddress: env("CONNECTION_ADDRESS"),
    }),
  );
}
