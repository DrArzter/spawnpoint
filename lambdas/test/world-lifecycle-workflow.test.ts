import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type State = {
  Type: string;
  Next?: string;
  End?: boolean;
  Default?: string;
  Resource?: string;
  Parameters?: Record<string, unknown>;
  Choices?: Array<Record<string, unknown>>;
};
type Definition = { StartAt: string; States: Record<string, State> };

async function definition(): Promise<Definition> {
  const source = await readFile(new URL("../../workflows/world-lifecycle.asl.json.tftpl", import.meta.url), "utf8");
  return JSON.parse(source
    .replace("${stop_state_machine_arn}", "arn:aws:states:eu-central-1:123456789012:stateMachine:stop")
    .replace("${world_lifecycle_function_arn}", "arn:aws:lambda:eu-central-1:123456789012:function:world-lifecycle")) as Definition;
}

test("world lifecycle is a closed graph", async () => {
  const graph = await definition();
  const names = new Set(Object.keys(graph.States));
  assert.ok(names.has(graph.StartAt));
  for (const [name, state] of Object.entries(graph.States)) {
    const targets = [state.Next, state.Default, ...(state.Choices ?? []).map((choice) => choice.Next)]
      .filter((value): value is string => typeof value === "string");
    for (const target of targets) assert.ok(names.has(target), `${name} -> ${target} does not exist`);
  }
});

test("a running session is synchronously stopped and backed up before mutation", async () => {
  const graph = await definition();
  const stop = graph.States["Stop And Back Up"]!;
  const mutate = graph.States["Apply World Mutation"]!;
  assert.equal(stop.Resource, "arn:aws:states:::states:startExecution.sync:2");
  assert.equal(stop.Next, "Apply World Mutation");
  assert.equal(mutate.Resource, "arn:aws:states:::lambda:invoke");
  assert.match(JSON.stringify(stop.Parameters), /worldId/);
  assert.match(JSON.stringify(mutate.Parameters), /targetGenerationId/);
});

test("a stopped host mutates without being started", async () => {
  const graph = await definition();
  const choice = graph.States["Needs Verified Stop"]!;
  assert.equal(choice.Default, "Apply World Mutation");
  assert.equal(choice.Choices?.[0]?.Next, "Stop And Back Up");
  assert.doesNotMatch(JSON.stringify(graph), /startInstances|start-server/);
});
