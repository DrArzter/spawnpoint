import type { Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

export type RenderMode = "reply" | "edit";

// One rendering path keeps every screen on HTML entities and lets callback
// navigation replace the current card rather than filling the chat with a new
// message for every tap.
export async function render(
  ctx: Context,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
  mode: RenderMode = "reply",
): Promise<void> {
  const options = {
    parse_mode: "HTML" as const,
    ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
  };
  if (mode === "edit" && ctx.callbackQuery?.message !== undefined) {
    try {
      await ctx.editMessageText(text, options);
    } catch (error) {
      // Refreshing an unchanged status is a successful no-op from the user's
      // point of view, although Telegram reports it as a 400 API error.
      if (error instanceof Error && error.message.includes("message is not modified")) return;
      throw error;
    }
    return;
  }
  await ctx.reply(text, options);
}
