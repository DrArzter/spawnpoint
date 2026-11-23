import assert from "node:assert/strict";
import { test } from "node:test";

import { configuredEmailSender, emailDeliveryProvider } from "../src/email/email-delivery.ts";

function dependencies() {
  const read: string[] = [];
  let sesClients = 0;
  return {
    read,
    sesClients: () => sesClients,
    readSecret: async (name: string) => { read.push(name); return "re_key"; },
    sesClient: () => { sesClients += 1; return { send: async () => ({ MessageId: "ses-1" }) }; },
  };
}

test("no provider, or none, means no sender and no secret read", async () => {
  const deps = dependencies();
  assert.equal(await configuredEmailSender({}, deps), null);
  assert.equal(await configuredEmailSender({ EMAIL_DELIVERY_PROVIDER: "none" }, deps), null);
  assert.deepEqual(deps.read, []);
});

test("SES needs only a sender address, and reads no secret", async () => {
  const deps = dependencies();
  const sender = await configuredEmailSender({ EMAIL_DELIVERY_PROVIDER: "ses", EMAIL_FROM: "Spawnpoint <auth@example.dev>" }, deps);
  assert.ok(sender);
  assert.equal(deps.sesClients(), 1);
  assert.deepEqual(deps.read, []);
});

test("Resend reads its key from the named parameter", async () => {
  const deps = dependencies();
  const sender = await configuredEmailSender({
    EMAIL_DELIVERY_PROVIDER: "resend",
    EMAIL_FROM: "Spawnpoint <auth@example.dev>",
    RESEND_API_KEY_PARAMETER: "/spawnpoint/email/resend-api-key",
  }, deps);
  assert.ok(sender);
  assert.deepEqual(deps.read, ["/spawnpoint/email/resend-api-key"]);
  assert.equal(deps.sesClients(), 0);
});

test("an unknown provider or a missing sender fails loudly", async () => {
  assert.throws(() => emailDeliveryProvider({ EMAIL_DELIVERY_PROVIDER: "smtp" }), /unsupported email delivery provider: smtp/);
  await assert.rejects(configuredEmailSender({ EMAIL_DELIVERY_PROVIDER: "ses" }, dependencies()), /EMAIL_FROM is empty/);
  await assert.rejects(configuredEmailSender({ EMAIL_DELIVERY_PROVIDER: "resend", EMAIL_FROM: "a <a@example.dev>" }, dependencies()), /RESEND_API_KEY_PARAMETER is empty/);
});
