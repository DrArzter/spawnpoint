// Everything that arrives on its own and deserves the chat: workflow and
// access events from EventBridge, plus guardrail alerts from the SNS topic
// (budget, cost anomalies, the running-hours alarm). One function, one send
// path. Least privilege by construction: two parameters, the access read model
// and the Telegram API — no Step Functions, no EC2, no S3.

import { createHash } from "node:crypto";

import { renderAlert } from "../domain/alerts.ts";
import { parseAccessApprovedEvent, renderAccessApproved } from "../domain/access-events.ts";
import { invitationDeliveryStatus, parseInvitationEvent, renderInvitation, renderInvitationEmail, type InvitationEvent } from "../domain/invitations.ts";
import { notificationSubscriptionKey, parseExecutionEvent, renderNotification } from "../domain/notifications.ts";
import { parseChatIds } from "../domain/telegram-bot.ts";
import type { EmailSender } from "../email/email-sender.ts";
import { createResendEmailSender } from "../email/resend-email-sender.ts";
import { env, parameter } from "./services/aws.ts";
import { claimInvitationDelivery, completeInvitationDelivery, subscribedNotificationTargets, subscribedTelegramChatIds } from "./services/subscribers.ts";

type SnsEvent = Readonly<{
  Records?: ReadonlyArray<{ Sns?: { Subject?: string | null; Message?: string } }>;
}>;
type EventBridgeEvent = Readonly<{ source?: string; "detail-type"?: string; detail?: unknown }>;

async function configuredChatIds(): Promise<readonly number[]> {
  return parseChatIds(await parameter(env("CHAT_IDS_PARAMETER"), 60));
}

let configuredEmailSender: Promise<EmailSender | null> | undefined;
function emailSender(): Promise<EmailSender | null> {
  configuredEmailSender ??= (async () => {
    const provider = process.env.EMAIL_DELIVERY_PROVIDER ?? "none";
    if (provider === "none") return null;
    if (provider !== "resend") throw new Error(`unsupported email delivery provider: ${provider}`);
    const replyTo = process.env.EMAIL_REPLY_TO;
    return createResendEmailSender({
      apiKey: await parameter(env("RESEND_API_KEY_PARAMETER")),
      from: env("EMAIL_FROM"),
      ...(replyTo === undefined ? {} : { replyTo }),
    });
  })();
  return configuredEmailSender;
}

async function sendToTargets(
  text: string,
  chatIds: readonly number[],
  options: Readonly<{ throwOnTotalFailure?: boolean; replyMarkup?: Record<string, unknown> }> = {},
): Promise<{ targetCount: number; successCount: number }> {
  if (chatIds.length === 0) return { targetCount: 0, successCount: 0 };
  const token = await parameter(env("BOT_TOKEN_PARAMETER"));

  const results = await Promise.allSettled(
    chatIds.map(async (chatId) => {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_notification: false,
          ...(options.replyMarkup === undefined ? {} : { reply_markup: options.replyMarkup }),
        }),
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
  if ((options.throwOnTotalFailure ?? true) && failures.length === results.length) {
    throw new Error("every notification target failed");
  }
  return { targetCount: results.length, successCount: results.length - failures.length };
}

async function sendInvitationEmails(
  invitation: InvitationEvent,
  addresses: readonly string[],
): Promise<{ targetCount: number; successCount: number }> {
  const sender = await emailSender();
  if (sender === null || addresses.length === 0) return { targetCount: 0, successCount: 0 };
  const message = renderInvitationEmail(invitation, env("MINI_APP_URL"));
  const results = await Promise.allSettled(addresses.map((address) => sender.send({
    ...message,
    to: address,
    idempotencyKey: `game-invitation/${invitation.invitationId}/${createHash("sha256").update(address).digest("hex").slice(0, 24)}`,
    tags: [{ name: "category", value: "game_invitation" }],
  })));
  const failures = results.filter((result) => result.status === "rejected");
  for (const failure of failures) console.error((failure as PromiseRejectedResult).reason);
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
  if (eventBridge.source === "spawnpoint.access" && eventBridge["detail-type"] === "Access Approved") {
    const approval = parseAccessApprovedEvent(eventBridge.detail);
    if (approval === null) {
      console.error("unparseable access approval", JSON.stringify(event).slice(0, 500));
      return;
    }
    const miniAppUrl = env("MINI_APP_URL");
    await sendToTargets(renderAccessApproved(approval), [approval.telegramChatId], { replyMarkup: {
      inline_keyboard: [
        [{ text: "Open panel", web_app: { url: miniAppUrl } }],
        [{ text: "Open panel in browser", url: miniAppUrl }],
      ],
    } });
    return;
  }

  if (eventBridge.source === "spawnpoint.access" && eventBridge["detail-type"] === "Game Invitation") {
    const invitation = parseInvitationEvent(eventBridge.detail);
    if (invitation === null) {
      console.error("unparseable invitation", JSON.stringify(event).slice(0, 500));
      return;
    }
    if (!await claimInvitationDelivery(invitation.invitationId)) return;
    try {
      const key = invitation.audience === "broadcast" ? "invitation.broadcast" : "invitation.direct";
      const subscribers = await subscribedNotificationTargets(key, invitation.audience === "direct"
        ? { include: invitation.recipientIdentityIds, exclude: [invitation.senderIdentityId] }
        : { exclude: [invitation.senderIdentityId] });
      const groups = invitation.audience === "broadcast" ? (await configuredChatIds()).filter((chatId) => chatId < 0) : [];
      const [telegram, email] = await Promise.all([
        sendToTargets(renderInvitation(invitation), [...new Set([...groups, ...subscribers.telegramChatIds])], { throwOnTotalFailure: false }),
        sendInvitationEmails(invitation, subscribers.emailAddresses),
      ]);
      const delivery = {
        targetCount: telegram.targetCount + email.targetCount,
        successCount: telegram.successCount + email.successCount,
      };
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
