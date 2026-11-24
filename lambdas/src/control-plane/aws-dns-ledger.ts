import { ChangeResourceRecordSetsCommand, ListResourceRecordSetsCommand, type Route53Client } from "@aws-sdk/client-route-53";

import { PARKED_DNS_ADDRESS, type DnsLedgerRecord } from "./dns-ledger.ts";

type Route53 = Pick<Route53Client, "send">;

function recordSet(record: DnsLedgerRecord, value: string) {
  return { Name: record.name, Type: "A" as const, TTL: 30, ResourceRecords: [{ Value: value }] };
}

async function currentDnsRecord(route53: Route53, record: DnsLedgerRecord): Promise<boolean> {
  const result = await route53.send(new ListResourceRecordSetsCommand({
    HostedZoneId: record.zoneId,
    StartRecordName: record.name,
    StartRecordType: "A",
    MaxItems: 1,
  }));
  const current = result.ResourceRecordSets?.[0];
  return current?.Name?.toLowerCase() === record.name && current.Type === "A" &&
    current.TTL === 30 && current.ResourceRecords?.length === 1 &&
    current.ResourceRecords[0]?.Value === record.address;
}

/**
 * After a host dies without stopping its session: one batch DELETEs the exact
 * address it published and CREATEs the parked one, so the name never
 * disappears and no resolver caches it as missing. A name that already holds
 * another address (a newer session) is left alone.
 */
export async function parkDnsRecord(route53: Route53, record: DnsLedgerRecord): Promise<void> {
  if (!(await currentDnsRecord(route53, record))) return;
  try {
    await route53.send(new ChangeResourceRecordSetsCommand({
      HostedZoneId: record.zoneId,
      ChangeBatch: { Changes: [
        { Action: "DELETE", ResourceRecordSet: recordSet(record, record.address) },
        { Action: "CREATE", ResourceRecordSet: recordSet(record, PARKED_DNS_ADDRESS) },
      ] },
    }));
  } catch (error) {
    if (!(error instanceof Error && error.name === "InvalidChangeBatch" && !(await currentDnsRecord(route53, record)))) throw error;
  }
}
