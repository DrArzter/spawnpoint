import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { statusKeyboard } from "../keyboards/main-menu.ts";
import { env, instanceState, readPointer } from "../services/aws.ts";
import { render, type RenderMode } from "../ui/render.ts";
import { contextIsAuthorized } from "../middleware/auth.ts";

export async function statusCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  const authorized = contextIsAuthorized(ctx);
  const [state, pointer] = await Promise.all([instanceState(), authorized ? readPointer() : Promise.resolve(null)]);
  const connectionAddress = env("CONNECTION_ADDRESS");
  await render(
    ctx,
    authorized ? replies.status({
      instanceState: state,
      desiredRelease: pointer?.desired_release ?? null,
      activeRelease: pointer?.active_release ?? null,
      connectionAddress,
    }) : replies.publicStatus(state),
    statusKeyboard(authorized && state === "running" ? connectionAddress : undefined),
    mode,
  );
}
