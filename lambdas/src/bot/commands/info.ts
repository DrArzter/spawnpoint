import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { addressKeyboard, networkKeyboard } from "../keyboards/main-menu.ts";
import { connectionAddress, env } from "../services/aws.ts";
import { render, type RenderMode } from "../ui/render.ts";

export async function networkCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  const networkId = env("ZEROTIER_NETWORK_ID");
  await render(ctx, replies.network(networkId), networkKeyboard(networkId), mode);
}

export async function addressCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  // Host part from the connectivity strategy, port from the game this bot's
  // world runs — the same composition the panel and the host perform.
  const address = connectionAddress();
  const panelAddress = env("PANEL_ADDRESS");
  await render(
    ctx,
    replies.address({
      connectionAddress: address,
      panelAddress,
    }),
    addressKeyboard(address, panelAddress),
    mode,
  );
}
