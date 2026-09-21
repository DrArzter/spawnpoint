import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { launchFamilies } from "../src/control-plane/catalog.ts";

// The catalog names the families the preview tool asks EC2 about; the
// operations root names the families the start's Fleet request carries. Two
// lists of the same thing, kept equal here rather than by remembering.
test("the launch families the Terraform fleet request carries are the catalog's", async () => {
  const url = new URL("../../infra/terraform-operations/variables.tf", import.meta.url);
  const variables = await readFile(url, "utf8");
  const block = variables.match(/variable "launch_families" \{[\s\S]*?default\s*=\s*\[([^\]]*)\]/);
  assert.ok(block, "variable launch_families with a default list");
  const terraformDefault = [...block![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(terraformDefault, [...launchFamilies]);
});
