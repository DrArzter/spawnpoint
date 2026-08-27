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

export function mainMenuKeyboard(miniAppUrl?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (miniAppUrl !== undefined) keyboard.webApp("Open panel", miniAppUrl).row();
  return keyboard
    .text("Status", callbacks.status)
    .text("Addresses", callbacks.address)
    .row()
    .text("ZeroTier", callbacks.network)
    .text("Client pack", callbacks.pack)
    .row()
    .text("Start server", callbacks.requestStart);
}

export function confirmStartKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Start server", callbacks.confirmStart)
    .row()
    .text("Cancel", callbacks.menu);
}

export function statusKeyboard(connectionAddress?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("Refresh", callbacks.status);
  if (connectionAddress !== undefined) {
    keyboard.copyText("Copy address", connectionAddress);
  }
  return keyboard.row().text("Menu", callbacks.menu);
}

export function addressKeyboard(connectionAddress: string, panelAddress: string): InlineKeyboard {
  return new InlineKeyboard()
    .copyText("Copy Minecraft address", connectionAddress)
    .copyText("Copy Grafana address", panelAddress)
    .row()
    .text("Menu", callbacks.menu);
}

export function networkKeyboard(networkId: string): InlineKeyboard {
  return new InlineKeyboard()
    .copyText("Copy network ID", networkId)
    .row()
    .copyText("Copy Linux command", `sudo zerotier-cli join ${networkId}`)
    .row()
    .text("Menu", callbacks.menu);
}

export function packKeyboard(url?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (url !== undefined) keyboard.url("Download client pack", url).row();
  return keyboard.text("Menu", callbacks.menu);
}
