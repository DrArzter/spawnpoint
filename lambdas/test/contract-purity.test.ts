import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// Review X2 (R24): ../contract is what the API and the panel share. Both builds
// accept it only while it stays plain TypeScript: no Node module, no AWS SDK,
// no DOM and no React. It imports nothing but its own files.

const folder = new URL("../../contract/", import.meta.url);

test("the shared contract imports only its own files, and reaches for no runtime", async () => {
  const files = (await readdir(folder)).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0);
  for (const name of files) {
    const source = await readFile(new URL(name, folder), "utf8");
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/g)) {
      const specifier = match[1] ?? match[2] ?? "";
      assert.match(specifier, /^\.\/[a-z-]+\.ts$/, `${name} imports ${specifier}: the contract imports only its own files`);
    }
    assert.doesNotMatch(source, /\b(?:process|window|document|Buffer|localStorage)\b\./, `${name} reaches for a runtime global`);
  }
});
