import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const directory = new URL("../src/handlers/api/", import.meta.url);

async function modules(): Promise<Map<string, string>> {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".ts"));
  return new Map(await Promise.all(files.map(async (file) => [file, await readFile(new URL(file, directory), "utf8")] as const)));
}

test("API imports form an acyclic graph; functional handlers never import their composition root", async () => {
  const sources = await modules();
  const graph = new Map<string, string[]>();
  for (const [file, source] of sources) {
    const imports = [...source.matchAll(/from "\.\/([^"/]+\.ts)"/g)].map((match) => match[1]!);
    graph.set(file, imports);
    assert.doesNotMatch(source, /from "\.\.\/access-api\.ts"/, `${file} imports the Lambda entry`);
    if (file !== "route-table.ts") {
      assert.ok(!imports.includes("route-table.ts"), `${file} imports the route composition root`);
      assert.ok(!imports.some((name) => name.endsWith("-routes.ts")), `${file} imports another feature's routes`);
    }
  }
  const visited = new Set<string>();
  function visit(file: string, chain: readonly string[]) {
    assert.ok(!chain.includes(file), `API import cycle: ${[...chain, file].join(" -> ")}`);
    if (visited.has(file)) return;
    for (const target of graph.get(file) ?? []) {
      assert.ok(sources.has(target), `${file} imports missing ${target}`);
      visit(target, [...chain, file]);
    }
    visited.add(file);
  }
  for (const file of sources.keys()) visit(file, []);
});

test("the Lambda entry only composes modules, without routes or feature logic", async () => {
  const entry = await readFile(new URL("../src/handlers/access-api.ts", import.meta.url), "utf8");
  assert.match(entry, /export const handler = createDispatcher\(routes,/);
  assert.doesNotMatch(entry, /process\.env|new \w+Command|(?:public|session|identity|permission)Route\(/);
});
