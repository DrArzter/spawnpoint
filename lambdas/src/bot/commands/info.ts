import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { addressKeyboard, networkKeyboard } from "../keyboards/main-menu.ts";
import { env, readWorldRecord } from "../services/aws.ts";
import { catalogWithPresets, worldAddress } from "../../control-plane/catalog.ts";
import { render, type RenderMode } from "../ui/render.ts";

export async function networkCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  const networkId = env("ZEROTIER_NETWORK_ID");
  await render(ctx, replies.network(networkId), networkKeyboard(networkId), mode);
}

/** The bot's world's address, composed from its record as the panel and the host compose it; null without a record. */
export async function botWorldAddress(publicIp: string | null): Promise<string | null> {
  const record = await readWorldRecord();
  if (record === null) return null;
  return worldAddress(record.worldId, { connectionHost: env("CONNECTION_HOST"), publicIp }, catalogWithPresets([], undefined, [record]));
}

export async function addressCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  // The standing address. A public world has none to print here: its address is issued per session.
  const connectionAddress = await botWorldAddress(null);
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
