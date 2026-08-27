import { InlineKeyboard } from "grammy";

export const callbacks = {
  menu: "menu:main",
  status: "menu:status",
  address: "menu:address",
  network: "menu:network",
  pack: "menu:pack",
  requestStart: "menu:start",
  confirmStart: "start:confirm",
} as const;

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📊 Server status", callbacks.status)
    .text("📍 Server address", callbacks.address)
    .row()
    .text("🌐 Join ZeroTier", callbacks.network)
    .text("📦 Client pack", callbacks.pack)
    .row()
    .text("🚀 Start game server", callbacks.requestStart);
}

export function confirmStartKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Yes, start it", callbacks.confirmStart)
    .row()
    .text("↩️ Back", callbacks.menu);
}

export function statusKeyboard(connectionAddress?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("🔄 Refresh", callbacks.status);
  if (connectionAddress !== undefined) {
    keyboard.copyText("📋 Copy address", connectionAddress);
  }
  return keyboard.row().text("↩️ Main menu", callbacks.menu);
}

export function addressKeyboard(connectionAddress: string, panelAddress: string): InlineKeyboard {
  return new InlineKeyboard()
    .copyText("📋 Minecraft", connectionAddress)
    .copyText("📋 Grafana", panelAddress)
    .row()
    .text("↩️ Main menu", callbacks.menu);
}

export function networkKeyboard(networkId: string): InlineKeyboard {
  return new InlineKeyboard()
    .copyText("📋 Network ID", networkId)
    .row()
    .copyText("📋 Linux join command", `sudo zerotier-cli join ${networkId}`)
    .row()
    .text("↩️ Main menu", callbacks.menu);
}

export function packKeyboard(url?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (url !== undefined) keyboard.url("⬇️ Download client pack", url).row();
  return keyboard.text("↩️ Main menu", callbacks.menu);
}
