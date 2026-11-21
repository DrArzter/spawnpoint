import assert from "node:assert/strict";
import test from "node:test";

import type { Context } from "grammy";

process.env.AWS_REGION ??= "eu-central-1";

const { startCommand } = await import("../src/bot/commands/start.ts");

const identity = "00000000-0000-4000-8000-000000000001";

function chat(telegramId: number) {
  const replies: string[] = [];
  const ctx = {
    from: { id: telegramId, is_bot: false, first_name: "Player" },
    reply: async (text: string) => { replies.push(text); },
  } as unknown as Context;
  return { ctx, replies };
}

function sessions(running = false) {
  const requesters: string[] = [];
  return {
    requesters,
    starter: {
      isRunning: async () => running,
      start: async (requestedBy: string) => { requesters.push(requestedBy); return "bot-20261121T120000Z"; },
    },
  };
}

test("a bot start names the person by identity, never by Telegram id", async () => {
  const { ctx, replies } = chat(111);
  const { requesters, starter } = sessions();
  await startCommand(ctx, { identityId: async (id) => (id === 111 ? identity : null) }, "reply", starter);
  assert.deepEqual(requesters, [`identity:${identity}`]);
  assert.ok(!requesters.some((requester) => requester.includes("111")));
  assert.match(replies[0] ?? "", /starting/i);
});

test("a Telegram account with no linked identity starts nothing", async () => {
  const { ctx, replies } = chat(222);
  const { requesters, starter } = sessions();
  await startCommand(ctx, { identityId: async () => null }, "reply", starter);
  assert.deepEqual(requesters, []);
  assert.equal(replies.length, 1);
});

test("a running session is reported before any identity lookup", async () => {
  const { ctx } = chat(111);
  const { requesters, starter } = sessions(true);
  let looked = false;
  await startCommand(ctx, { identityId: async () => { looked = true; return identity; } }, "reply", starter);
  assert.equal(looked, false);
  assert.deepEqual(requesters, []);
});
