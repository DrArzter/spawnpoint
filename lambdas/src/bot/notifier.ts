// Everything that arrives on its own and deserves the chat: Step Functions
// execution events from EventBridge, and guardrail alerts from the SNS topic
// (budget, cost anomalies, the running-hours alarm). One function, two event
// shapes, one send path. Least privilege by construction: two parameters and
// the Telegram API — no Step Functions, no EC2, no S3.

import { renderAlert } from "../domain/alerts.ts";
import { notificationSubscriptionKey, parseExecutionEvent, renderNotification } from "../domain/notifications.ts";
import { parseChatIds } from "../domain/telegram-bot.ts";
import { env, parameter } from "./services/aws.ts";
import { subscribedTelegramChatIds } from "./services/subscribers.ts";

type SnsEvent = Readonly<{
  Records?: ReadonlyArray<{ Sns?: { Subject?: string | null; Message?: string } }>;
}>;
type EventBridgeEvent = Readonly<{ detail?: unknown }>;

async function configuredChatIds(): Promise<readonly number[]> {
  return parseChatIds(await parameter(env("CHAT_IDS_PARAMETER"), 60));
}

async function sendToTargets(text: string, chatIds: readonly number[]): Promise<void> {
  if (chatIds.length === 0) return;
  const token = await parameter(env("BOT_TOKEN_PARAMETER"));

  const results = await Promise.allSettled(
    chatIds.map(async (chatId) => {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_notification: false }),
      });
      if (!response.ok) {
        throw new Error(`sendMessage to ${chatId} failed: ${response.status} ${await response.text()}`);
      }
    }),
  );

  const failures = results.filter((result) => result.status === "rejected");
  for (const failure of failures) console.error((failure as PromiseRejectedResult).reason);
  // One unreachable chat (a member who never opened the bot) must not spend
  // the retry; only a total failure is worth another swing.
  if (failures.length === results.length) {
    throw new Error("every notification target failed");
  }
}

export async function handler(event: SnsEvent | EventBridgeEvent): Promise<void> {
  const records = (event as SnsEvent).Records;
  if (Array.isArray(records)) {
    for (const record of records) {
      if (record.Sns?.Message === undefined) continue;
      await sendToTargets(renderAlert({ subject: record.Sns.Subject ?? null, message: record.Sns.Message }), await configuredChatIds());
    }
    return;
  }

  const parsed = parseExecutionEvent((event as EventBridgeEvent).detail);
  if (parsed === null) {
    console.error("unparseable event", JSON.stringify(event).slice(0, 500));
    return;
  }
  const text = renderNotification(parsed);
  if (text === null) return;
  const subscriptionKey = notificationSubscriptionKey(parsed);
  if (subscriptionKey === null) {
    await sendToTargets(text, await configuredChatIds());
    return;
  }
  const [configured, subscribers] = await Promise.all([configuredChatIds(), subscribedTelegramChatIds(subscriptionKey)]);
  const groups = configured.filter((chatId) => chatId < 0);
  await sendToTargets(text, [...new Set([...groups, ...subscribers])]);
}
