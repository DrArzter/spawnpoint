import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { addressKeyboard, networkKeyboard } from "../keyboards/main-menu.ts";
import { env } from "../services/aws.ts";
import { worldAddress } from "../../control-plane/catalog.ts";
import { render, type RenderMode } from "../ui/render.ts";

export async function networkCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  const networkId = env("ZEROTIER_NETWORK_ID");
  await render(ctx, replies.network(networkId), networkKeyboard(networkId), mode);
}

export async function addressCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  // The standing address, composed as the panel and the host compose it. A
  // public world has none to print here: its address is issued per session.
  const connectionAddress = worldAddress(env("WORLD_ID"), { connectionHost: env("CONNECTION_HOST"), publicIp: null });
  const panelAddress = env("PANEL_ADDRESS");
  await render(
    ctx,
    replies.address({
      connectionAddress,
      panelAddress,
    }),
    addressKeyboard(connectionAddress, panelAddress),
    mode,
  );
}
