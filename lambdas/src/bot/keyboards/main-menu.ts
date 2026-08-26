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
