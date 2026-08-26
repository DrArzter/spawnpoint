import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { env } from "../services/aws.ts";

export async function networkCommand(ctx: Context): Promise<void> {
  await ctx.reply(replies.network(env("ZEROTIER_NETWORK_ID")), { parse_mode: "HTML" });
}

export async function addressCommand(ctx: Context): Promise<void> {
  await ctx.reply(
    replies.address({
      connectionAddress: env("CONNECTION_ADDRESS"),
      panelAddress: env("PANEL_ADDRESS"),
    }),
    { parse_mode: "HTML" },
  );
}
