import assert from "node:assert/strict";
import test from "node:test";

import { PARKED_DNS_ADDRESS, parkDnsRecord } from "../src/control-plane/dns-ledger.ts";

// ADR-0086: a stopped world's name answers a parked address; it never disappears.

const record = { zoneId: "Z123ABC", name: "prominence.games.example.com.", address: "63.185.95.28" } as const;

function route53(current: string | null, options: { failChange?: string } = {}) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  let value = current;
  return {
    sent,
    client: {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        sent.push({ name: command.constructor.name, input: command.input });
        if (command.constructor.name === "ListResourceRecordSetsCommand") {
          return { ResourceRecordSets: value === null ? [] : [{ Name: record.name, Type: "A", TTL: 30, ResourceRecords: [{ Value: value }] }] };
        }
        if (options.failChange) throw Object.assign(new Error("refused"), { name: options.failChange });
        value = PARKED_DNS_ADDRESS;
        return {};
      },
    },
  };
}

test("a dead host's address is replaced by the parked one in one batch", async () => {
  const { client, sent } = route53(record.address);
  await parkDnsRecord(client as never, record);
  const change = sent.find((call) => call.name === "ChangeResourceRecordSetsCommand");
  const changes = (change?.input.ChangeBatch as { Changes: { Action: string; ResourceRecordSet: { ResourceRecords: { Value: string }[] } }[] }).Changes;
  assert.deepEqual(changes.map((item) => [item.Action, item.ResourceRecordSet.ResourceRecords[0]?.Value]), [["DELETE", record.address], ["CREATE", "192.0.2.1"]]);
});

test("a name that already holds a newer address, or none, is left alone", async () => {
  for (const current of ["3.120.1.1", null]) {
    const { client, sent } = route53(current);
    await parkDnsRecord(client as never, record);
    assert.equal(sent.some((call) => call.name === "ChangeResourceRecordSetsCommand"), false);
  }
});

test("a change that loses a race to a newer session is not an error; any other failure is", async () => {
  const { client } = route53(record.address, { failChange: "InvalidChangeBatch" });
  let looks = 0;
  // The second look finds the newer session's address: the refusal was that race.
  const racing = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) =>
    command.constructor.name === "ListResourceRecordSetsCommand" && looks++ > 0
      ? { ResourceRecordSets: [{ Name: record.name, Type: "A", TTL: 30, ResourceRecords: [{ Value: "3.120.1.1" }] }] }
      : client.send(command) };
  await parkDnsRecord(racing as never, record);
  await assert.rejects(parkDnsRecord(route53(record.address, { failChange: "Throttling" }).client as never, record), { name: "Throttling" });
});
