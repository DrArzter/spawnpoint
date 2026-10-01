import assert from "node:assert/strict";
import test from "node:test";

import { readMcpConnectRoute } from "../src/routing.ts";

test("reads only a non-empty signed MCP connection request", () => {
  assert.equal(readMcpConnectRoute("#/connect?request=signed.request"), "signed.request");
  assert.equal(readMcpConnectRoute("#/connect?request="), null);
  assert.equal(readMcpConnectRoute("#/worlds"), null);
});
