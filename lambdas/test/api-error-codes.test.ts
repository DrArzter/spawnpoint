import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { API_ERROR_CODES } from "../../contract/errors.ts";

// The panel's API refuses only with the codes contract/errors.ts declares:
// errorResponse takes an ApiErrorCode, so the compiler checks every refusal.
// These tests keep the two other ways out shut: a handler that writes an error
// body itself, and a declared code that nothing sends any more.

const source = fileURLToPath(new URL("../src/", import.meta.url));
// OAuth and MCP answer their own clients with the codes of their own standards.
const OWN_STANDARD = new Set(["oauth.ts", "mcp.ts"]);

async function files(directory: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      const path = join(entry.parentPath, entry.name);
      found.set(path.slice(source.length), await readFile(path, "utf8"));
    }
  }
  return found;
}

const all = await files(source);

test("every refusal of the panel's API goes through errorResponse", () => {
  const direct = [...all].flatMap(([path, text]) => {
    if (!path.startsWith("handlers/api/") || OWN_STANDARD.has(path.slice("handlers/api/".length))) return [];
    return [...text.matchAll(/\bresponse(?:WithHeaders|WithCookies)?\([^;]*?\{\s*error:/g)].map(() => path);
  });
  assert.deepEqual(direct, []);
});

test("every declared code is one the Lambdas still send", () => {
  const text = [...all.values()].join("\n");
  const unused = API_ERROR_CODES.filter((code) => !text.includes(`"${code}"`));
  assert.deepEqual(unused, []);
});
