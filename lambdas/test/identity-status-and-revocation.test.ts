import assert from "node:assert/strict";
import test from "node:test";

process.env.ACCESS_TABLE_NAME = "access-api-test";
process.env.BOT_TOKEN_PARAMETER ??= "/spawnpoint/bot/token";
process.env.SESSION_SIGNING_SECRET_PARAMETER ??= "/spawnpoint/auth/session-signing-secret";
process.env.PANEL_URL ??= "https://spawnpoint.example";
process.env.API_URL ??= "https://api.spawnpoint.example";
const { document } = await import("../src/handlers/api/access-store.ts");
const { resolveIdentity } = await import("../src/handlers/api/identity-store.ts");
const { revokePasswordLoginSessions } = await import("../src/handlers/api/email-actions.ts");

type Sent = Readonly<{ name: string; input: Record<string, unknown> }>;

function commandOf(command: unknown): Sent {
  return { name: (command as object).constructor.name, input: (command as { input: Record<string, unknown> }).input };
}

test("only an active identity is resolved from a login, as by id", async (t) => {
  for (const [status, expected] of [["ACTIVE", "id-1"], ["SUSPENDED", null], [undefined, null]] as const) {
    t.mock.method(document, "send", async (command: unknown) => {
      const { input } = commandOf(command);
      const key = (input.Key as { pk: string } | undefined)?.pk ?? "";
      if (key.startsWith("IDENTITY#")) return { Item: { pk: key, sk: "PROFILE", identity_id: "id-1", display_name: "Someone", role_id: "viewer", direct_grants: [], ...(status === undefined ? {} : { status }) } };
      return { Item: { identity_id: "id-1" } };
    });
    const identity = await resolveIdentity({ provider: "telegram", subject: "42" } as never);
    assert.equal(identity?.id ?? null, expected, `status ${String(status)}`);
    t.mock.restoreAll();
  }
});

test("a password reset revokes the sessions on every page, not only the first", async (t) => {
  const revoked: string[] = [];
  t.mock.method(document, "send", async (command: unknown) => {
    const { name, input } = commandOf(command);
    if (name === "QueryCommand") {
      return input.ExclusiveStartKey === undefined
        ? { Items: [{ pk: "SESSION#a", sk: "SESSION", entity_type: "LOGIN_SESSION" }], LastEvaluatedKey: { pk: "SESSION#a" } }
        : { Items: [{ pk: "SESSION#b", sk: "SESSION", entity_type: "LOGIN_SESSION" }, { pk: "ACCOUNT#x", sk: "ACCOUNT", entity_type: "ACCOUNT" }] };
    }
    revoked.push((input.Key as { pk: string }).pk);
    return {};
  });
  await revokePasswordLoginSessions("subject-1");
  assert.deepEqual(revoked.sort(), ["SESSION#a", "SESSION#b"]);
});
