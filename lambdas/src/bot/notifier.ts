// Everything that arrives on its own and deserves the chat: Step Functions
// execution events from EventBridge, and guardrail alerts from the SNS topic
// (budget, cost anomalies, the running-hours alarm). One function, two event
// shapes, one send path. Least privilege by construction: two parameters and
// the Telegram API — no Step Functions, no EC2, no S3.

import { renderAlert } from "../domain/alerts.ts";
import { invitationDeliveryStatus, parseInvitationEvent, renderInvitation } from "../domain/invitations.ts";
import { notificationSubscriptionKey, parseExecutionEvent, renderNotification } from "../domain/notifications.ts";
import { parseChatIds } from "../domain/telegram-bot.ts";
import { env, parameter } from "./services/aws.ts";
import { claimInvitationDelivery, completeInvitationDelivery, subscribedTelegramChatIds } from "./services/subscribers.ts";

type SnsEvent = Readonly<{
  Records?: ReadonlyArray<{ Sns?: { Subject?: string | null; Message?: string } }>;
}>;
type EventBridgeEvent = Readonly<{ source?: string; "detail-type"?: string; detail?: unknown }>;

async function configuredChatIds(): Promise<readonly number[]> {
  return parseChatIds(await parameter(env("CHAT_IDS_PARAMETER"), 60));
}

async function sendToTargets(text: string, chatIds: readonly number[], throwOnTotalFailure = true): Promise<{ targetCount: number; successCount: number }> {
  if (chatIds.length === 0) return { targetCount: 0, successCount: 0 };
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
  if (throwOnTotalFailure && failures.length === results.length) {
    throw new Error("every notification target failed");
  }
  return { targetCount: results.length, successCount: results.length - failures.length };
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

  const eventBridge = event as EventBridgeEvent;
  if (eventBridge.source === "spawnpoint.access" && eventBridge["detail-type"] === "Game Invitation") {
    const invitation = parseInvitationEvent(eventBridge.detail);
    if (invitation === null) {
      console.error("unparseable invitation", JSON.stringify(event).slice(0, 500));
      return;
    }
    if (!await claimInvitationDelivery(invitation.invitationId)) return;
    try {
      const key = invitation.audience === "broadcast" ? "invitation.broadcast" : "invitation.direct";
      const subscribers = await subscribedTelegramChatIds(key, invitation.audience === "direct"
        ? { include: invitation.recipientIdentityIds, exclude: [invitation.senderIdentityId] }
        : { exclude: [invitation.senderIdentityId] });
      const groups = invitation.audience === "broadcast" ? (await configuredChatIds()).filter((chatId) => chatId < 0) : [];
      const delivery = await sendToTargets(renderInvitation(invitation), [...new Set([...groups, ...subscribers])], false);
      await completeInvitationDelivery(
        invitation.invitationId,
        invitationDeliveryStatus(delivery.targetCount, delivery.successCount),
        delivery.targetCount,
        delivery.successCount,
      );
    } catch (error) {
      console.error("invitation delivery failed before completion", error);
      await completeInvitationDelivery(invitation.invitationId, "FAILED", 0, 0);
    }
    return;
  }

  const parsed = parseExecutionEvent(eventBridge.detail);
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
