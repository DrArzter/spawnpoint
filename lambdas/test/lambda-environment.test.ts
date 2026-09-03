import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A Lambda reads its configuration from process.env, and Terraform writes that
// environment in a `variables = { ... }` block — two lists, kept in step by
// nothing. The gap already bit once: "The address is composed" replaced
// CONNECTION_ADDRESS with CONNECTION_HOST in the Terraform roots while the bot
// and the API kept reading the old name, so every start and status would have
// thrown on apply. Here each Lambda's source graph is walked from its entry,
// every environment name it reads is collected, and each must be provided by
// the block that deploys it.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Provided by the Lambda runtime itself, never by Terraform.
const runtimeProvided = new Set(["AWS_REGION"]);

type LambdaDefinition = Readonly<{
  name: string;
  entry: string;
  terraform: string;
  // Modules on the import graph whose function-level reads serve another
  // Lambda's code paths; the notifier imports services/aws.ts for its `env`
  // and `parameter` helpers alone.
  ignore?: readonly string[];
}>;

const lambdas: readonly LambdaDefinition[] = [
  { name: "telegram bot", entry: "lambdas/src/bot/handler.ts", terraform: "infra/terraform-bot/bot.tf" },
  {
    name: "notifier",
    entry: "lambdas/src/bot/notifier.ts",
    terraform: "infra/terraform-bot/notifier.tf",
    ignore: ["lambdas/src/bot/services/aws.ts"],
  },
  { name: "access api", entry: "lambdas/src/handlers/access-api.ts", terraform: "infra/terraform-access-api/api.tf" },
];

// A read with a fallback — `process.env.X ?? "default"` — is a choice the code
// makes for itself and needs nothing from Terraform; every other read throws or
// misbehaves when the name is absent, so it must be provided.
export function environmentReads(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/\b(?:requiredEnv|env)\("([A-Z_]+)"\)|process\.env\.([A-Z_]+)(\s*\?\?)?/g)) {
    if (match[3] !== undefined) continue;
    names.add(match[1] ?? match[2]!);
  }
  return names;
}

export function terraformEnvironment(terraform: string): Set<string> {
  const start = terraform.indexOf("variables = {");
  assert.notEqual(start, -1, "no environment block found");
  const block = terraform.slice(start, terraform.indexOf("\n    }", start));
  return new Set([...block.matchAll(/^\s+([A-Z_]+)\s+=/gm)].map((match) => match[1]!));
}

async function importGraph(entry: string): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const queue = [resolve(root, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (sources.has(file)) continue;
    const source = await readFile(file, "utf8");
    sources.set(file, source);
    for (const match of source.matchAll(/from "(\.{1,2}\/[^"]+\.ts)"/g)) {
      queue.push(resolve(dirname(file), match[1]!));
    }
  }
  return sources;
}

export function missingEnvironment(
  sources: ReadonlyMap<string, string>,
  provided: ReadonlySet<string>,
  ignore: ReadonlySet<string>,
): Map<string, string[]> {
  const missing = new Map<string, string[]>();
  for (const [file, source] of sources) {
    if (ignore.has(file)) continue;
    for (const name of environmentReads(source)) {
      if (provided.has(name) || runtimeProvided.has(name)) continue;
      missing.set(name, [...(missing.get(name) ?? []), file]);
    }
  }
  return missing;
}

for (const lambda of lambdas) {
  test(`the ${lambda.name} reads only environment its Terraform provides`, async () => {
    const sources = await importGraph(lambda.entry);
    const provided = terraformEnvironment(await readFile(resolve(root, lambda.terraform), "utf8"));
    const ignore = new Set((lambda.ignore ?? []).map((file) => resolve(root, file)));
    for (const file of ignore) assert.ok(sources.has(file), `${file} is not on the import graph; drop it from ignore`);
    const missing = missingEnvironment(sources, provided, ignore);
    assert.deepEqual(
      [...missing.entries()].map(([name, files]) => `${name} <- ${files.map((f) => f.slice(root.length + 1)).join(", ")}`),
      [],
      `${lambda.terraform} does not provide every variable the code reads`,
    );
  });
}

test("the guard reports a name the code reads and Terraform omits", () => {
  const sources = new Map([["/src/x.ts", 'const a = env("PRESENT"); const b = requiredEnv("ABSENT"); process.env.ALSO_ABSENT; const c = process.env.OPTIONAL ?? "default";']]);
  const missing = missingEnvironment(sources, new Set(["PRESENT"]), new Set());
  assert.deepEqual([...missing.keys()].sort(), ["ABSENT", "ALSO_ABSENT"], "a read with a fallback is not a requirement");
  assert.deepEqual([...missingEnvironment(sources, new Set(["PRESENT", "ABSENT", "ALSO_ABSENT"]), new Set()).keys()], []);
});

test("the block parser reads the deployed bot's variables", async () => {
  const provided = terraformEnvironment(await readFile(resolve(root, "infra/terraform-bot/bot.tf"), "utf8"));
  assert.ok(provided.has("CONNECTION_HOST"));
  assert.ok(!provided.has("CONNECTION_ADDRESS"), "the composed address replaced the configured one");
});
