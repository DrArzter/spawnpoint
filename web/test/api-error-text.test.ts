import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { API_ERROR_TEXT } from "../src/api/error-text.ts";

// Every error code the API sends needs text in the panel. The test reads the
// backend source: a literal `error: "code"`, `reason: "code"` or
// `reject(409, "code")` is a code. A code that a variable carries is not found
// here, so error-text.ts lists those by hand.

const api = new URL("../../lambdas/src/handlers/api/", import.meta.url);
const plane = new URL("../../lambdas/src/control-plane/", import.meta.url);
// OAuth and MCP errors go to a connecting app, not to this panel.
const NOT_FOR_THE_PANEL = new Set(["oauth.ts", "mcp.ts", "mcp-routes.ts", "oauth-routes.ts"]);
const PLANE_FILES = ["promotion.ts", "game-settings.ts", "console.ts", "whitelist.ts", "release-usable.ts"];

const CODE = /\b(?:error|reason):\s*((?:"[a-z][a-z_]*"\s*\|?\s*)+)|\breject\(\d+,\s*"([a-z][a-z_]*)"/g;

function codesIn(source: string): string[] {
  return [...source.matchAll(CODE)].flatMap((match) => match[2] ? [match[2]] : [...match[1].matchAll(/"([a-z_]+)"/g)].map((literal) => literal[1]));
}

function backendCodes(): Map<string, string> {
  const found = new Map<string, string>();
  const read = (folder: URL, files: readonly string[]) => {
    for (const file of files) for (const code of codesIn(readFileSync(new URL(file, folder), "utf8"))) found.set(code, `${folder.pathname.split("/").slice(-4).join("/")}${file}`);
  };
  read(api, readdirSync(api).filter((file) => file.endsWith(".ts") && !NOT_FOR_THE_PANEL.has(file)));
  read(plane, PLANE_FILES);
  return found;
}

test("every error code the backend sends has text in the panel", () => {
  const codes = backendCodes();
  assert.ok(codes.size > 50, `the scan found only ${codes.size} codes: has the backend moved?`);
  const missing = [...codes].filter(([code]) => !(code in API_ERROR_TEXT)).map(([code, file]) => `${code} (${file})`);
  assert.deepEqual(missing, [], "add these codes to API_ERROR_TEXT in web/src/api/error-text.ts");
});
