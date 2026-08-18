import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { packUrl, readPointer } from "../services/aws.ts";

export async function packCommand(ctx: Context): Promise<void> {
  const pointer = await readPointer();
  const release = pointer?.active_release ?? pointer?.desired_release;
  if (!release) {
    await ctx.reply(replies.packMissing("unknown"));
    return;
  }
  const url = await packUrl(release);
  await ctx.reply(url === null ? replies.packMissing(release) : replies.pack(release, url));
}
