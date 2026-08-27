import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { mainMenuKeyboard } from "../keyboards/main-menu.ts";
import { render, type RenderMode } from "../ui/render.ts";

// Telegram reserves /start for opening the bot. It must never be an
// operational side effect: pressing the standard Start button only shows the
// menu, even if the game host is stopped.
export async function welcomeCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  await render(ctx, replies.welcome(), mainMenuKeyboard(), mode);
}
