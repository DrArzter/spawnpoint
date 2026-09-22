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
