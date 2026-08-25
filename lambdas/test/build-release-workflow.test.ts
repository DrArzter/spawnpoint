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
  Catch?: Array<{ Next: string }>;
  Choices?: Array<Record<string, unknown>>;
};

type Definition = {
  StartAt: string;
  States: Record<string, State>;
};

async function loadDefinition(): Promise<Definition> {
  const url = new URL("../../workflows/build-release.asl.json.tftpl", import.meta.url);
  const template = await readFile(url, "utf8");
  return JSON.parse(template.replace("${project_name}", "spawnpoint-release-builder")) as Definition;
}

function state(definition: Definition, name: string): State {
  const result = definition.States[name];
  assert.ok(result, `missing state: ${name}`);
  return result;
}

test("build release is a closed small graph", async () => {
  const definition = await loadDefinition();
  const names = new Set(Object.keys(definition.States));
  assert.ok(names.has(definition.StartAt));

  for (const [name, current] of Object.entries(definition.States)) {
    const targets = [
      current.Next,
      current.Default,
      ...(current.Catch ?? []).map((caught) => caught.Next),
      ...(current.Choices ?? []).flatMap((choice) => {
        const direct = typeof choice.Next === "string" ? [choice.Next] : [];
        const and = Array.isArray(choice.And)
          ? (choice.And as Array<Record<string, unknown>>).flatMap((nested) =>
              typeof nested.Next === "string" ? [nested.Next] : [],
            )
          : [];
        return [...direct, ...and];
      }),
    ].filter((target): target is string => typeof target === "string");
    for (const target of targets) assert.ok(names.has(target), `${name} -> ${target} does not exist`);
  }
});

test("the workflow runs only the fixed builder and passes no authority", async () => {
  const definition = await loadDefinition();
  const build = state(definition, "Build Immutable Release");
  assert.equal(build.Resource, "arn:aws:states:::codebuild:startBuild.sync");
  assert.equal(build.Parameters?.ProjectName, "spawnpoint-release-builder");

  const overrides = build.Parameters?.EnvironmentVariablesOverride as Array<{ Name: string }>;
  assert.deepEqual(
    new Set(overrides.map((variable) => variable.Name)),
    new Set(["PROFILE_ID", "CONFIG_COMMIT", "RELEASE", "RELEASE_CREATED_BY"]),
  );
  assert.doesNotMatch(JSON.stringify(build), /CF_API_KEY|RELEASE_BUCKET|BuildspecOverride|SourceLocationOverride/);
});

test("READY is reachable only after synchronous CodeBuild success", async () => {
  const definition = await loadDefinition();
  const build = state(definition, "Build Immutable Release");
  assert.equal(build.Next, "Release Ready");
  assert.equal(build.Catch?.[0]?.Next, "Release Build Failed");
  assert.equal(state(definition, "Release Ready").Parameters?.status, "READY");
  assert.equal(state(definition, "Release Build Failed").Type, "Fail");
  assert.equal(state(definition, "Invalid Release Request").Type, "Fail");
});
