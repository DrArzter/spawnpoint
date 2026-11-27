import assert from "node:assert/strict";
import test from "node:test";
import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";

import { HOST_ENV_PATH, ssmHostEnvKeys } from "../src/control-plane/aws-host-env-keys.ts";
import { gameModules } from "../src/control-plane/game-modules.ts";
import { missingGameSecrets } from "../src/control-plane/launch-preflight.ts";

// ADR-0106: a game's required secrets are checked by name before a session starts.

const listing = (keys: readonly string[]) => {
  let reads = 0;
  return { port: { list: async () => { reads += 1; return keys; } }, reads: () => reads };
};

test("every required secret absent from the host env is named, in the manifest's order", async () => {
  for (const module of gameModules) {
    const { port } = listing(["AWS_REGION"]);
    assert.deepEqual(await missingGameSecrets(port, module.id), module.requiredSecrets, module.id);
    assert.deepEqual(await missingGameSecrets(listing([...module.requiredSecrets, "AWS_REGION"]).port, module.id), [], module.id);
  }
});

test("a game that needs no secret, or a game no module names, reads nothing", async () => {
  const none = gameModules.find((module) => module.requiredSecrets.length === 0);
  assert.ok(none, "one module needs no secret");
  const { port, reads } = listing([]);
  assert.deepEqual(await missingGameSecrets(port, none.id), []);
  assert.deepEqual(await missingGameSecrets(port, "no-such-game"), []);
  assert.equal(reads(), 0);
});

test("the adapter reads names on the host env path only, without decryption, across pages", async (t) => {
  const sent: GetParametersByPathCommand[] = [];
  t.mock.method(SSMClient.prototype, "send", async (command: unknown) => {
    assert.ok(command instanceof GetParametersByPathCommand);
    sent.push(command);
    return sent.length === 1
      ? { Parameters: [{ Name: `${HOST_ENV_PATH}/RCON_PASSWORD`, Value: "ciphertext" }], NextToken: "next" }
      : { Parameters: [{ Name: `${HOST_ENV_PATH}/AWS_REGION` }] };
  });
  const keys = await ssmHostEnvKeys(new SSMClient({ region: "eu-central-1" })).list();
  assert.deepEqual(keys, ["RCON_PASSWORD", "AWS_REGION"]);
  assert.deepEqual(sent.map((command) => [command.input.Path, command.input.WithDecryption, command.input.Recursive, command.input.NextToken]), [
    ["/spawnpoint/host/env", false, false, undefined],
    ["/spawnpoint/host/env", false, false, "next"],
  ]);
});
