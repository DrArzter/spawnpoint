import assert from "node:assert/strict";
import test from "node:test";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

process.env.AWS_REGION ??= "eu-central-1";
process.env.ACCESS_TABLE_NAME ??= "spawnpoint-access-test";

const { accessStore } = await import("../src/bot/services/access.ts");

function stubProfile(t: test.TestContext, profile: Record<string, unknown> | undefined): void {
  t.mock.method(DynamoDBDocumentClient.prototype, "send", async (command: { input: { Key: { pk: string } } }) =>
    command.input.Key.pk.startsWith("TELEGRAM#")
      ? { Item: { identity_id: "id-1" } }
      : { Item: profile === undefined ? undefined : { identity_id: "id-1", display_name: "Ada", ...profile } });
}

test("the bot resolves permissions through the shared resolver", async (t) => {
  stubProfile(t, { status: "ACTIVE", role_id: "operator", direct_grants: [] });
  assert.equal(await accessStore.hasPermission(1, "session.stop"), true);
  assert.equal(await accessStore.hasPermission(1, "access.manage"), false);
});

test("the bot honours direct grants on an unknown role", async (t) => {
  stubProfile(t, { status: "ACTIVE", role_id: "retired-role", direct_grants: ["session.start"] });
  assert.equal(await accessStore.hasPermission(1, "session.start"), true);
  assert.equal(await accessStore.hasPermission(1, "status.read"), false);
});

test("the bot grants nothing to an identity that is not active or has no profile", async (t) => {
  stubProfile(t, { status: "DELETING", role_id: "owner", direct_grants: [] });
  assert.equal(await accessStore.hasPermission(1, "status.read"), false);
  t.mock.restoreAll();
  stubProfile(t, undefined);
  assert.equal(await accessStore.hasPermission(1, "status.read"), false);
});
