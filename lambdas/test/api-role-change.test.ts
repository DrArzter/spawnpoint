import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { type Identity } from "../src/access/domain.ts";

process.env.ACCESS_TABLE_NAME = "access-api-test";
const { document } = await import("../src/handlers/api/access-store.ts");
const { updateRole } = await import("../src/handlers/api/access.ts");

const ids = {
  first: "00000000-0000-4000-8000-000000000001",
  second: "00000000-0000-4000-8000-000000000002",
  manager: "00000000-0000-4000-8000-000000000003",
};

type Profile = { identity_id: string; display_name: string; role_id: string; direct_grants: string[]; status: string };
type Expression = Readonly<{ Key: { pk: string }; ConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> }>;
type Command = Readonly<{ constructor: { name: string }; input: Record<string, unknown> }>;

// Holds profiles by identity id. Conditions are the few forms the role change
// writes. `ownerCount` answers the index query, which may lag the profiles.
function table(t: TestContext, profiles: Profile[], ownerCount?: () => number) {
  const byId = new Map(profiles.map((profile) => [profile.identity_id, { ...profile }]));
  const pages: unknown[] = [];
  const holds = (key: string, input: Expression): boolean => {
    const profile = byId.get(key.replace("IDENTITY#", ""));
    if (profile === undefined) return false;
    const values = input.ExpressionAttributeValues;
    return profile.status === values[":active"]
      && (!input.ConditionExpression.includes("role_id = :owner") || profile.role_id === values[":owner"])
      && (!input.ConditionExpression.includes("role_id = :current") || profile.role_id === values[":current"]);
  };
  t.mock.method(document, "send", async (command: Command) => {
    const input = command.input;
    if (command.constructor.name === "GetCommand") {
      return { Item: byId.get((input.Key as { pk: string }).pk.replace("IDENTITY#", "")) };
    }
    if (command.constructor.name === "QueryCommand") {
      pages.push(input.ExclusiveStartKey);
      // Two pages, so a count that ignores the cursor is caught.
      const owners = ownerCount?.() ?? [...byId.values()].filter((profile) => profile.status === "ACTIVE" && profile.role_id === "owner").length;
      return input.ExclusiveStartKey === undefined
        ? { Count: Math.min(owners, 1), LastEvaluatedKey: { pk: "cursor" } }
        : { Count: Math.max(owners - 1, 0) };
    }
    if (command.constructor.name === "TransactWriteCommand") {
      await Promise.resolve();
      const items = input.TransactItems as { ConditionCheck?: Expression; Update?: Expression }[];
      const checks = items.map((item) => item.ConditionCheck ?? item.Update).filter((item) => item !== undefined);
      if (!checks.every((check) => holds(check.Key.pk, check))) {
        throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
      }
      const update = items.find((item) => item.Update !== undefined)?.Update;
      const target = byId.get(update!.Key.pk.replace("IDENTITY#", ""))!;
      target.role_id = String(update!.ExpressionAttributeValues[":roleId"]);
      return {};
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  });
  return { byId, pages };
}

const profile = (id: string, roleId: string, directGrants: string[] = []): Profile => ({
  identity_id: id, display_name: id, role_id: roleId, direct_grants: directGrants, status: "ACTIVE",
});

const identity = (item: Profile): Identity => ({
  id: item.identity_id, displayName: item.display_name, roleId: item.role_id, directGrants: item.direct_grants as Identity["directGrants"],
});

const demote = (caller: Profile, target: string) => updateRole(identity(caller), target, JSON.stringify({ roleId: "operator" }));

test("a manager without the Owner grant cannot demote an Owner", async (t) => {
  const owner = profile(ids.first, "owner");
  const manager = profile(ids.manager, "operator", ["access.manage"]);
  const { byId } = table(t, [owner, manager]);
  assert.equal((await demote(manager, ids.first)).statusCode, 403);
  assert.equal(byId.get(ids.first)?.role_id, "owner");
});

test("the last Owner cannot be demoted, and the count reads every page", async (t) => {
  const owner = profile(ids.first, "owner");
  const other = profile(ids.second, "owner");
  const { byId, pages } = table(t, [owner, other], () => 1);
  const refused = await demote(owner, ids.second);
  assert.equal(refused.statusCode, 409);
  assert.deepEqual(JSON.parse(refused.body as string), { error: "last_owner" });
  assert.equal(pages.length, 2);
  assert.equal(byId.get(ids.second)?.role_id, "owner");
});

test("an Owner demotes another Owner while two remain", async (t) => {
  const owner = profile(ids.first, "owner");
  const { byId } = table(t, [owner, profile(ids.second, "owner")]);
  assert.equal((await demote(owner, ids.second)).statusCode, 200);
  assert.equal(byId.get(ids.second)?.role_id, "operator");
});

test("two Owners who demote each other at once leave one Owner", async (t) => {
  const first = profile(ids.first, "owner");
  const second = profile(ids.second, "owner");
  // The index still counts both Owners for both requests.
  const { byId } = table(t, [first, second], () => 2);
  const results = await Promise.all([demote(first, ids.second), demote(second, ids.first)]);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
  assert.equal([...byId.values()].filter((item) => item.role_id === "owner").length, 1);
});

test("a manager still changes the role of a member who is not an Owner", async (t) => {
  const manager = profile(ids.manager, "operator", ["access.manage"]);
  const { byId } = table(t, [manager, profile(ids.second, "player")]);
  assert.equal((await demote(manager, ids.second)).statusCode, 200);
  assert.equal(byId.get(ids.second)?.role_id, "operator");
});

test("a missing or inactive target is not found", async (t) => {
  const owner = profile(ids.first, "owner");
  table(t, [owner, { ...profile(ids.second, "player"), status: "DISABLED" }]);
  assert.equal((await demote(owner, ids.second)).statusCode, 404);
  assert.equal((await demote(owner, ids.manager)).statusCode, 404);
});
