import assert from "node:assert/strict";
import test from "node:test";

import { createResendEmailSender } from "../src/email/resend-email-sender.ts";

test("the Resend adapter sends one idempotent transactional email", async () => {
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  const sender = createResendEmailSender({
    apiKey: "re_test_secret",
    from: "Spawnpoint <notifications@example.com>",
    replyTo: "owner@example.com",
    fetch: (async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ id: "email-123" }), { status: 200 });
    }) as typeof fetch,
  });

  assert.deepEqual(await sender.send({
    to: "player@example.com",
    subject: "Invitation",
    text: "Come play",
    html: "<p>Come play</p>",
    idempotencyKey: "game-invitation/invite-1/player-1",
    tags: [{ name: "category", value: "game_invitation" }],
  }), { id: "email-123" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "https://api.resend.com/emails");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer re_test_secret");
  assert.equal(new Headers(calls[0]?.init?.headers).get("idempotency-key"), "game-invitation/invite-1/player-1");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    from: "Spawnpoint <notifications@example.com>",
    to: ["player@example.com"],
    subject: "Invitation",
    text: "Come play",
    html: "<p>Come play</p>",
    reply_to: "owner@example.com",
    tags: [{ name: "category", value: "game_invitation" }],
  });
});

test("the Resend adapter reports bounded provider errors without exposing its key", async () => {
  const sender = createResendEmailSender({
    apiKey: "re_never_log_this",
    from: "notifications@example.com",
    fetch: (async () => new Response("upstream refused the message", { status: 422 })) as typeof fetch,
  });

  await assert.rejects(
    sender.send({ to: "player@example.com", subject: "x", text: "x", html: "<p>x</p>", idempotencyKey: "message/1" }),
    (error: Error) => error.message.includes("422") && !error.message.includes("re_never_log_this"),
  );
});

test("the Resend adapter refuses header injection in configuration", () => {
  assert.throws(() => createResendEmailSender({ apiKey: "re_test", from: "ok@example.com\nBcc: victim@example.com" }), /invalid Resend from/);
});
