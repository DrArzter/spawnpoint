import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { statusKeyboard } from "../keyboards/main-menu.ts";
import { describeHost, env, readPointer } from "../services/aws.ts";
import { worldAddress } from "../../control-plane/catalog.ts";
import { render, type RenderMode } from "../ui/render.ts";
import { contextIsAuthorized } from "../middleware/auth.ts";

export async function statusCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  const authorized = contextIsAuthorized(ctx);
  const [host, pointer] = await Promise.all([describeHost(), authorized ? readPointer() : Promise.resolve(null)]);
  const state = host.state;
  // Composed per strategy, like the panel: the overlay address for an overlay
  // world, the instance's current public address for a public one.
  const connectionAddress = worldAddress(env("WORLD_ID"), { connectionHost: env("CONNECTION_HOST"), publicIp: host.publicIp });
  await render(
    ctx,
    authorized ? replies.status({
      instanceState: state,
      desiredRelease: pointer?.desired_release ?? null,
      activeRelease: pointer?.active_release ?? null,
      connectionAddress,
    }) : replies.publicStatus(state),
    statusKeyboard(authorized && state === "running" && connectionAddress !== null ? connectionAddress : undefined),
    mode,
  );
}
