import assert from "node:assert/strict";
import { test } from "node:test";

import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { createSesEmailSender } from "../src/email/ses-email-sender.ts";

const message = {
  to: "player@example.dev",
  subject: "Verify your email",
  text: "Open the link.",
  html: "<p>Open the link.</p>",
  idempotencyKey: "verify-1",
  tags: [{ name: "category", value: "email.verify" }],
};

function client(messageId: string | undefined = "ses-1") {
  const sent: SendEmailCommand[] = [];
  return { sent, send: async (command: SendEmailCommand) => { sent.push(command); return { MessageId: messageId }; } };
}

test("an SES message carries both bodies, the sender, the reply-to and SES-safe tags", async () => {
  const ses = client();
  const sender = createSesEmailSender({ client: ses, from: "Spawnpoint <auth@example.dev>", replyTo: "owner@example.dev" });
  assert.deepEqual(await sender.send(message), { id: "ses-1" });
  const input = ses.sent[0]!.input;
  assert.equal(input.FromEmailAddress, "Spawnpoint <auth@example.dev>");
  assert.deepEqual(input.Destination, { ToAddresses: ["player@example.dev"] });
  assert.deepEqual(input.ReplyToAddresses, ["owner@example.dev"]);
  assert.equal(input.Content?.Simple?.Subject?.Data, "Verify your email");
  assert.equal(input.Content?.Simple?.Body?.Text?.Data, "Open the link.");
  assert.equal(input.Content?.Simple?.Body?.Html?.Data, "<p>Open the link.</p>");
  assert.deepEqual(input.EmailTags, [{ Name: "category", Value: "email_verify" }]);
});

test("an SES sender without a reply-to or tags sends neither", async () => {
  const ses = client();
  const sender = createSesEmailSender({ client: ses, from: "Spawnpoint <auth@example.dev>", replyTo: " " });
  const { tags: _tags, ...untagged } = message;
  await sender.send(untagged);
  assert.equal(ses.sent[0]!.input.ReplyToAddresses, undefined);
  assert.equal(ses.sent[0]!.input.EmailTags, undefined);
});

test("an SES sender refuses a header-breaking address and a reply without a message id", async () => {
  assert.throws(() => createSesEmailSender({ client: client(), from: "a@example.dev\r\nBcc: x@example.dev" }), /invalid SES from address/);
  const sender = createSesEmailSender({ client: client(""), from: "Spawnpoint <auth@example.dev>" });
  await assert.rejects(sender.send(message), /no message id/);
  await assert.rejects(createSesEmailSender({ client: client(), from: "Spawnpoint <auth@example.dev>" }).send({ ...message, to: "x@example.dev\nBcc: y@example.dev" }), /invalid SES recipient/);
});
