import type { LifecycleRecord } from "../domain/lifecycle.ts";
import type { HostObservation, OperationObservation } from "./read-model.ts";

export type DynamicControlPlaneProjection = Readonly<{
  schemaVersion: 1;
  observedAtEpochMilliseconds: number;
  hosts: readonly HostObservation[];
  operations: readonly OperationObservation[];
}>;

export type ControlPlaneEvent = Readonly<{
  id: string;
  source: string;
  "detail-type": string;
  time: string;
  detail?: unknown;
}>;

export type RecoveryTarget = Readonly<{
  serverId: string;
  sessionId: string;
  worldId: string;
  instanceId: string;
}>;

const HOST_STATES = new Set(["pending", "running", "stopping", "stopped", "unknown"]);
const OPERATION_TYPES = new Set(["start", "stop", "promote", "world"]);
const EVENT_ID = /^[A-Za-z0-9-]{1,128}$/;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function host(value: unknown): HostObservation | null {
  const item = object(value);
  if (item === null || typeof item.id !== "string" || typeof item.name !== "string" ||
      typeof item.state !== "string" || !HOST_STATES.has(item.state) || typeof item.providerRef !== "string") return null;
  const instanceType = nullableString(item.instanceType);
  const availabilityZone = nullableString(item.availabilityZone);
  const launchedAt = nullableString(item.launchedAt);
  const publicIp = nullableString(item.publicIp);
  if (instanceType === undefined || availabilityZone === undefined || launchedAt === undefined || publicIp === undefined) return null;
  return {
    id: item.id,
    name: item.name,
    state: item.state as HostObservation["state"],
    providerRef: item.providerRef,
    instanceType,
    availabilityZone,
    launchedAt,
    publicIp,
  };
}

function operation(value: unknown): OperationObservation | null {
  const item = object(value);
  if (item === null || typeof item.id !== "string" || typeof item.type !== "string" || !OPERATION_TYPES.has(item.type) ||
      item.status !== "running" || typeof item.startedAt !== "string" || typeof item.providerRef !== "string") return null;
  return {
    id: item.id,
    type: item.type as OperationObservation["type"],
    status: "running",
    startedAt: item.startedAt,
    providerRef: item.providerRef,
  };
}

export function parseDynamicProjection(
  value: unknown,
  nowEpochMilliseconds: number,
  maxAgeMilliseconds = 10 * 60 * 1000,
): DynamicControlPlaneProjection | null {
  const item = object(value);
  if (item === null || item.schema_version !== 1 || !Number.isSafeInteger(item.observed_at_epoch_ms) ||
      !Array.isArray(item.hosts) || !Array.isArray(item.operations)) return null;
  const observedAt = item.observed_at_epoch_ms as number;
  if (observedAt > nowEpochMilliseconds + 60_000 || nowEpochMilliseconds - observedAt > maxAgeMilliseconds) return null;
  const hosts = item.hosts.map(host);
  const operations = item.operations.map(operation);
  if (hosts.some((entry) => entry === null) || operations.some((entry) => entry === null)) return null;
  return {
    schemaVersion: 1,
    observedAtEpochMilliseconds: observedAt,
    hosts: hosts as HostObservation[],
    operations: operations as OperationObservation[],
  };
}

function safeEventDetail(event: ControlPlaneEvent): Record<string, string> {
  const detail = object(event.detail);
  if (detail === null) return {};
  if (event.source === "aws.ec2") {
    return {
      ...(typeof detail["instance-id"] === "string" ? { instanceId: detail["instance-id"] } : {}),
      ...(typeof detail.state === "string" ? { state: detail.state } : {}),
    };
  }
  if (event.source === "aws.states") {
    return {
      ...(typeof detail.executionArn === "string" ? { executionArn: detail.executionArn } : {}),
      ...(typeof detail.stateMachineArn === "string" ? { stateMachineArn: detail.stateMachineArn } : {}),
      ...(typeof detail.status === "string" ? { status: detail.status } : {}),
    };
  }
  return typeof detail.trigger === "string" ? { trigger: detail.trigger } : {};
}

export function eventJournalItem(event: ControlPlaneEvent, expiresAtEpochSeconds: number): Record<string, unknown> {
  if (!EVENT_ID.test(event.id)) throw new Error("control-plane event id is invalid");
  const occurredAt = new Date(event.time);
  if (Number.isNaN(occurredAt.valueOf())) throw new Error("control-plane event time is invalid");
  const day = occurredAt.toISOString().slice(0, 10);
  return {
    pk: `EVENT#${day}`,
    sk: `${occurredAt.toISOString()}#${event.id}`,
    schema_version: 1,
    event_id: event.id,
    source: event.source,
    detail_type: event["detail-type"],
    occurred_at: occurredAt.toISOString(),
    detail: safeEventDetail(event),
    expires_at: expiresAtEpochSeconds,
  };
}

export function recoveryTarget(
  hosts: readonly HostObservation[],
  operations: readonly OperationObservation[],
  lifecycles: readonly LifecycleRecord[],
  nowEpochSeconds: number,
): RecoveryTarget | null {
  if (hosts.length !== 1 || hosts[0]?.state !== "stopped" || operations.length !== 0) return null;
  const candidates = lifecycles.filter((record) =>
    record.observedState !== "stopped" &&
    record.activeSessionId !== null && record.activeWorldId !== null &&
    (record.lease === null || record.lease.expiresAtEpochSeconds <= nowEpochSeconds));
  if (candidates.length !== 1) return null;
  const record = candidates[0]!;
  return {
    serverId: record.serverId,
    sessionId: record.activeSessionId!,
    worldId: record.activeWorldId!,
    instanceId: hosts[0].providerRef,
  };
}

export function hostOwnsSession(record: unknown, hostId: string, sessionId: string): boolean {
  const hostRecord = object(record);
  if (hostRecord?.hostId !== hostId || !Array.isArray(hostRecord.reservations)) return false;
  return hostRecord.reservations.some((value) => object(value)?.sessionId === sessionId);
}
