import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { packKeyboard } from "../keyboards/main-menu.ts";
import { packUrl, readPointer } from "../services/aws.ts";
import { render, type RenderMode } from "../ui/render.ts";

export async function packCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  const pointer = await readPointer();
  const release = pointer?.active_release ?? pointer?.desired_release;
  if (!release) {
    await render(ctx, replies.packMissing("unknown"), packKeyboard(), mode);
    return;
  }
  const url = await packUrl(release);
  await render(
    ctx,
    url === null ? replies.packMissing(release) : replies.pack(release),
    packKeyboard(url ?? undefined),
    mode,
  );
}
