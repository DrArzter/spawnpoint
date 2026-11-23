import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

process.env.ACCESS_TABLE_NAME = "access-api-test";
const { document } = await import("../src/handlers/api/access-store.ts");
const { approve, dismiss } = await import("../src/handlers/api/access.ts");
const { isConditionFailure } = await import("../src/handlers/api/conditions.ts");

const owner = { id: "owner", displayName: "Owner", roleId: "owner", directGrants: [] } as const;

function failure(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

// The candidate reads as open, then the write finds another request was first.
function raced(t: TestContext, name: string) {
  t.mock.method(document, "send", async (command: unknown) => {
    if (command?.constructor?.name === "GetCommand") return { Item: { pk: "ACCOUNT#telegram#42", sk: "ACCOUNT", display_name: "Someone" } };
    throw failure(name);
  });
}

test("an approval that loses the race to another Owner is a conflict, not a server fault", async (t) => {
  raced(t, "TransactionCanceledException");
  const result = await approve(owner, "telegram", "42", JSON.stringify({ roleId: "viewer" }));
  assert.equal(result.statusCode, 409);
  assert.deepEqual(JSON.parse(result.body), { error: "candidate_unavailable" });
});

test("dismissing a candidate that was approved meanwhile is a conflict", async (t) => {
  raced(t, "ConditionalCheckFailedException");
  const result = await dismiss(owner, "telegram", "42");
  assert.equal(result.statusCode, 409);
  assert.deepEqual(JSON.parse(result.body), { error: "candidate_unavailable" });
});

test("any other failure still reaches the caller as a fault", async (t) => {
  raced(t, "ProvisionedThroughputExceededException");
  await assert.rejects(() => dismiss(owner, "telegram", "42"), /ProvisionedThroughputExceededException/);
});

test("only DynamoDB's condition refusals count as conflicts", () => {
  assert.equal(isConditionFailure(failure("ConditionalCheckFailedException")), true);
  assert.equal(isConditionFailure(failure("TransactionCanceledException")), true);
  assert.equal(isConditionFailure(failure("ValidationException")), false);
  assert.equal(isConditionFailure("ConditionalCheckFailedException"), false);
});
