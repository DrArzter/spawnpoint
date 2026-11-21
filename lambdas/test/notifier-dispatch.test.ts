import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";

// Which event reaches which chats with which text. Only the AWS clients and
// the Telegram API are replaced; parsing, rendering and routing are real.

process.env.AWS_REGION ??= "eu-central-1";
process.env.ACCESS_TABLE_NAME ??= "spawnpoint-access-test";
process.env.BOT_TOKEN_PARAMETER ??= "/test/bot/token";
process.env.CHAT_IDS_PARAMETER ??= "/test/bot/chat-ids";
process.env.MINI_APP_URL ??= "https://example.invalid/panel";

const { handler } = await import("../src/bot/notifier.ts");
const { renderAlert } = await import("../src/domain/alerts.ts");
const { renderAccessApproved } = await import("../src/domain/access-events.ts");
const { renderInvitation } = await import("../src/domain/invitations.ts");

const GROUP = -100;
const OPERATOR = 555;
const SUBSCRIBER = 777;

type Sent = { chatId: number; text: string; replyMarkup?: unknown };
type Write = { command: string; input: Record<string, unknown> };

function harness(options: Readonly<{ subscribed?: boolean; claimed?: boolean }> = {}) {
  const sent: Sent[] = [];
  const writes: Write[] = [];
  mock.method(SSMClient.prototype, "send", async (command: { input: { Name: string } }) => ({
    Parameter: { Value: command.input.Name === process.env.CHAT_IDS_PARAMETER ? `${GROUP},${OPERATOR}` : "123:TEST" },
  }));
  mock.method(DynamoDBDocumentClient.prototype, "send", async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    if (name === "ScanCommand") {
      return { Items: options.subscribed ? [{ pk: "IDENTITY#subscriber", sk: "SUBSCRIPTIONS", subscriptions: { "minecraft.started": true, "invitation.broadcast": true } }] : [] };
    }
    if (name === "QueryCommand") return { Items: [{ platform: "telegram", chat_id: String(SUBSCRIBER) }] };
    if (name === "UpdateCommand") {
      writes.push({ command: name, input: command.input });
      if (options.claimed && (command.input.ExpressionAttributeValues as Record<string, unknown>)[":ready"] === "READY") {
        throw Object.assign(new Error("claimed"), { name: "ConditionalCheckFailedException" });
      }
      return {};
    }
    throw new Error(`unexpected ${name}`);
  });
  mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { chat_id: number; text: string; reply_markup?: unknown };
    sent.push({ chatId: body.chat_id, text: body.text, ...(body.reply_markup === undefined ? {} : { replyMarkup: body.reply_markup }) });
    return new Response("{}", { status: 200 });
  });
  return { sent, writes };
}

const chats = (sent: readonly Sent[]) => sent.map((message) => message.chatId).sort((a, b) => a - b);
const execution = (machine: string, status: string, fields: Record<string, unknown> = {}) => ({
  source: "aws.states",
  "detail-type": "Step Functions Execution Status Change",
  detail: { stateMachineArn: `arn:aws:states:eu-central-1:123456789012:stateMachine:${machine}`, status, name: "bot-20261121T000000Z", ...fields },
});
const invitation = {
  invitationId: "inv-1", audience: "broadcast", gameId: "minecraft", gameName: "Minecraft",
  worldId: "world", worldName: "World", senderIdentityId: "sender", senderDisplayName: "Sender", recipientIdentityIds: [],
};

test.afterEach(() => mock.restoreAll());

test("a guardrail alert goes to every configured chat", async () => {
  const { sent } = harness();
  await handler({ Records: [{ Sns: { Subject: "Budget", Message: "over" } }, { Sns: {} }] });
  assert.deepEqual(chats(sent), [GROUP, OPERATOR]);
  assert.ok(sent.every((message) => message.text === renderAlert({ subject: "Budget", message: "over" })));
});

test("an access approval goes only to the approved person, with the panel buttons", async () => {
  const { sent } = harness();
  const detail = { telegramChatId: 4242, identityId: "id-1", displayName: "Player", roleName: "Player" };
  await handler({ source: "spawnpoint.access", "detail-type": "Access Approved", detail });
  assert.deepEqual(chats(sent), [4242]);
  assert.equal(sent[0]?.text, renderAccessApproved(detail));
  assert.deepEqual(sent[0]?.replyMarkup, { inline_keyboard: [
    [{ text: "Open panel", web_app: { url: process.env.MINI_APP_URL } }],
    [{ text: "Open panel in browser", url: process.env.MINI_APP_URL }],
  ] });
});

test("a broadcast invitation goes to groups and subscribers, and records its delivery", async () => {
  const { sent, writes } = harness({ subscribed: true });
  await handler({ source: "spawnpoint.access", "detail-type": "Game Invitation", detail: invitation });
  assert.deepEqual(chats(sent), [GROUP, SUBSCRIBER]);
  assert.ok(sent.every((message) => message.text === renderInvitation({ ...invitation, audience: "broadcast" })));
  const completed = writes.at(-1)?.input.ExpressionAttributeValues as Record<string, unknown>;
  assert.equal(completed[":status"], "DELIVERED");
  assert.equal(completed[":targets"], 2);
});

test("an invitation another delivery already claimed sends nothing", async () => {
  const { sent, writes } = harness({ claimed: true });
  await handler({ source: "spawnpoint.access", "detail-type": "Game Invitation", detail: invitation });
  assert.deepEqual(sent, []);
  assert.equal(writes.length, 1);
});

test("a start goes to groups and its subscribers, not to operator chats", async () => {
  const { sent } = harness({ subscribed: true });
  await handler(execution("spawnpoint-start-server-v2", "RUNNING", { input: JSON.stringify({ requestedBy: "identity:x" }) }));
  assert.deepEqual(chats(sent), [GROUP, SUBSCRIBER]);
  assert.ok(sent.every((message) => message.text === "[STARTING] identity:x requested the server. Mods take a few minutes."));
});

test("an alarm with no subscription goes to every configured chat", async () => {
  const { sent } = harness({ subscribed: true });
  await handler(execution("spawnpoint-stop-server-v2", "FAILED"));
  assert.deepEqual(chats(sent), [GROUP, OPERATOR]);
  assert.match(sent[0]?.text ?? "", /^\[ALARM\] A stop failed/);
});

test("an event with nothing to say sends nothing", async () => {
  const { sent } = harness();
  await handler(execution("spawnpoint-idle-watchdog-v2", "RUNNING"));
  await handler(execution("spawnpoint-unknown", "SUCCEEDED"));
  assert.deepEqual(sent, []);
});
