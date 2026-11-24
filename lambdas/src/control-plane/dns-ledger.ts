import { ChangeResourceRecordSetsCommand, ListResourceRecordSetsCommand, type Route53Client } from "@aws-sdk/client-route-53";
import type { ControlPlaneEvent } from "./dynamic-projection.ts";

export type DnsLedgerRecord = Readonly<{
  zoneId: string;
  name: string;
  address: string;
}>;

export function terminalHostInstanceId(event: ControlPlaneEvent): string | null {
  if (event.source !== "aws.ec2" || event["detail-type"] !== "EC2 Instance State-change Notification") return null;
  if (event.detail === null || typeof event.detail !== "object" || Array.isArray(event.detail)) return null;
  const detail = event.detail as Record<string, unknown>;
  if (detail.state !== "stopped" && detail.state !== "terminated") return null;
  const instanceId = detail["instance-id"];
  return typeof instanceId === "string" && /^i-[0-9a-f]+$/.test(instanceId) ? instanceId : null;
}

export function dnsLedgerRecords(value: unknown, zoneId: string, suffix: string): DnsLedgerRecord[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const item = value as Record<string, unknown>;
  if (item.records === null || typeof item.records !== "object" || Array.isArray(item.records)) return [];
  const records = item.records as Record<string, unknown>;
  return Object.values(records).flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    if (record.zone_id !== zoneId || typeof record.name !== "string" || typeof record.address !== "string") return [];
    const name = record.name.toLowerCase();
    if (!name.endsWith(`.${suffix}.`) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.$/.test(name)) return [];
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(record.address)) return [];
    return [{ zoneId, name, address: record.address }];
  });
}

/** What a stopped world's name answers (ADR-0086): TEST-NET-1, reserved and routed nowhere. */
export const PARKED_DNS_ADDRESS = "192.0.2.1";

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
