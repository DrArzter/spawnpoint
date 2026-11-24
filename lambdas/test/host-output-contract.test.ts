import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import hostOutput from "../../server/scripts/host-output.json" with { type: "json" };

// Review X1 (R20): what a host prints for the control plane is declared once,
// in server/scripts/host-output.json. The host writes it and the Lambdas read
// it; this test reads the scripts, so a renamed step or key fails here instead
// of vanishing from the panel's session box.

const server = new URL("../../server/", import.meta.url);

async function scripts(directory: URL): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await readdir(fileURLToPath(directory), { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".sh")) found.set(entry.name, await readFile(join(entry.parentPath, entry.name), "utf8"));
  }
  return found;
}

const all = new Map([...await scripts(new URL("scripts/", server)), ...await scripts(new URL("games/", server))]);

test("every step a host marks is declared, and every declared step is marked", () => {
  const marked = new Set([...all.values()].flatMap((source) => [...source.matchAll(/\bmark_step ([a-z][a-z0-9_]*)/g)].map((match) => match[1]!)));
  assert.deepEqual([...marked].sort(), Object.keys(hostOutput.steps).sort());
});

test("every key a session script prints is either shown or declared hidden, and none is declared twice or for nothing", () => {
  const printed = new Set<string>();
  for (const name of hostOutput.sessionScripts) {
    const source = all.get(name);
    assert.ok(source, `${name} is a session script`);
    for (const match of source.matchAll(/printf '([a-z_]{1,20})=/g)) printed.add(match[1]!);
  }
  printed.delete("step");
  const shown = Object.keys(hostOutput.results.shown);
  const declared = [...shown, ...hostOutput.results.hidden];
  assert.equal(new Set(declared).size, declared.length, "a key is shown or hidden, not both");
  assert.deepEqual([...printed].sort(), [...declared].sort());
  for (const key of declared) assert.match(key, new RegExp(hostOutput.resultKeyPattern));
});

test("every console exit code is declared where it is made", async () => {
  const consoleScript = all.get("console.sh") ?? "";
  const document = await readFile(new URL("../../infra/terraform-access-api/console.tf", import.meta.url), "utf8");
  const made = new Set([...`${consoleScript}\n${document}`.matchAll(/\bexit ([2-9])\b/g)].map((match) => match[1]!));
  assert.deepEqual([...made].sort(), Object.keys(hostOutput.console.exitCodes).sort());
  for (const code of hostOutput.console.unavailable) assert.ok(made.has(String(code)), `exit ${code} is made somewhere`);
});

test("every world log exit code is declared where it is made", async () => {
  const script = all.get("world-log.sh") ?? "";
  const document = await readFile(new URL("../../infra/terraform-access-api/world-log.tf", import.meta.url), "utf8");
  const made = new Set([...`${script}\n${document}`.matchAll(/\bexit ([2-9])\b/g)].map((match) => match[1]!));
  assert.deepEqual([...made].sort(), Object.keys(hostOutput.worldLog.exitCodes).sort());
  for (const code of hostOutput.worldLog.unavailable) assert.ok(made.has(String(code)), `exit ${code} is made somewhere`);
});
