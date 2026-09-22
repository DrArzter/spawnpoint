import assert from "node:assert/strict";
import test from "node:test";

import { dnsLedgerRecords, terminalHostInstanceId } from "../src/control-plane/dns-ledger.ts";

test("only stopped or terminated EC2 hosts trigger DNS cleanup", () => {
  const event = {
    id: "event-1", source: "aws.ec2", "detail-type": "EC2 Instance State-change Notification",
    time: "2026-09-22T00:00:00Z", detail: { "instance-id": "i-0123456789abcdef0", state: "stopped" },
  };
  assert.equal(terminalHostInstanceId(event), "i-0123456789abcdef0");
  assert.equal(terminalHostInstanceId({ ...event, detail: { ...event.detail, state: "terminated" } }), "i-0123456789abcdef0");
  assert.equal(terminalHostInstanceId({ ...event, detail: { ...event.detail, state: "running" } }), null);
  assert.equal(terminalHostInstanceId({ ...event, source: "other" }), null);
});

test("only DNS records owned by the configured zone and suffix are eligible", () => {
  const records = dnsLedgerRecords({ records: {
    factorio: { zone_id: "Z123", name: "factorio.spawnpoint.example.com.", address: "203.0.113.10" },
    unrelated: { zone_id: "ZOTHER", name: "other.spawnpoint.example.com.", address: "203.0.113.11" },
    outside: { zone_id: "Z123", name: "outside.example.com.", address: "203.0.113.12" },
  } }, "Z123", "spawnpoint.example.com");
  assert.deepEqual(records, [{ zoneId: "Z123", name: "factorio.spawnpoint.example.com.", address: "203.0.113.10" }]);
});
