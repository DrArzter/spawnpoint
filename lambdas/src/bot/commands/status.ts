import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { statusKeyboard } from "../keyboards/main-menu.ts";
import { env, instanceState, readPointer } from "../services/aws.ts";
import { render, type RenderMode } from "../ui/render.ts";

export async function statusCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  const [state, pointer] = await Promise.all([instanceState(), readPointer()]);
  const connectionAddress = env("CONNECTION_ADDRESS");
  await render(
    ctx,
    replies.status({
      instanceState: state,
      desiredRelease: pointer?.desired_release ?? null,
      activeRelease: pointer?.active_release ?? null,
      connectionAddress,
    }),
    statusKeyboard(state === "running" ? connectionAddress : undefined),
    mode,
  );
}
