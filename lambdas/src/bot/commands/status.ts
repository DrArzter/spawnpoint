import type { Context } from "grammy";

import { replies, worldSessionStatus, type WorldSessionStatus } from "../../domain/telegram-bot.ts";
import { statusKeyboard } from "../keyboards/main-menu.ts";
import { env, readPointer, readSession, readWorldRecord } from "../services/aws.ts";
import { botWorldAddress } from "./info.ts";
import { render, type RenderMode } from "../ui/render.ts";
import { contextIsAuthorized } from "../middleware/auth.ts";

export async function statusCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  const authorized = contextIsAuthorized(ctx);
  const [session, pointer] = await Promise.all([readWorldSessionStatus(), authorized ? readPointer() : Promise.resolve(null)]);
  const state = session.state;
  // The address the host reported for this session, else the standing one its connection gives.
  const connectionAddress = authorized ? session.address ?? await botWorldAddress(null) : null;
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

// The world's session, from the record its placement names: the panel reads the same one.
async function readWorldSessionStatus(): Promise<WorldSessionStatus> {
  try {
    const world = await readWorldRecord();
    if (world === null) return { state: "unknown", address: null };
    return worldSessionStatus(await readSession(world), env("WORLD_ID"));
  } catch {
    return { state: "unknown", address: null };
  }
}
