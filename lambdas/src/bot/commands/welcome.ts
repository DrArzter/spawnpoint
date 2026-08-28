import type { Context } from "grammy";

import { replies } from "../../domain/telegram-bot.ts";
import { mainMenuKeyboard, visitorMenuKeyboard } from "../keyboards/main-menu.ts";
import { contextIsAuthorized } from "../middleware/auth.ts";
import { env } from "../services/aws.ts";
import { render, type RenderMode } from "../ui/render.ts";

// Telegram reserves /start for opening the bot. It must never be an
// operational side effect: pressing the standard Start button only shows the
// menu, even if the game host is stopped.
export async function welcomeCommand(ctx: Context, mode: RenderMode = "reply"): Promise<void> {
  const authorized = contextIsAuthorized(ctx);
  await render(
    ctx,
    authorized ? replies.welcome() : replies.visitorWelcome(),
    authorized ? mainMenuKeyboard(env("MINI_APP_URL")) : visitorMenuKeyboard(),
    mode,
  );
}
