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
const OPERATION_TYPES = new Set(["start", "stop", "promote", "world", "host"]);
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
  // A launched host must stay launched when read back, or it counts as the configured one.
  const provenance = item.provenance === "configured" || item.provenance === "launched" ? item.provenance : undefined;
  const market = item.market === "spot" || item.market === "on-demand" || item.market === null ? item.market : undefined;
  return {
    id: item.id,
    name: item.name,
    state: item.state as HostObservation["state"],
    providerRef: item.providerRef,
    instanceType,
    availabilityZone,
    launchedAt,
    publicIp,
    ...(market === undefined ? {} : { market }),
    ...(provenance === undefined ? {} : { provenance }),
  };
}

function operation(value: unknown): OperationObservation | null {
  const item = object(value);
  if (item === null || typeof item.id !== "string" || typeof item.type !== "string" || !OPERATION_TYPES.has(item.type) ||
      item.status !== "running" || typeof item.startedAt !== "string" || typeof item.providerRef !== "string") return null;
  // A projection written before operations named their world names none.
  const worldId = item.worldId === undefined ? null : nullableString(item.worldId);
  if (worldId === undefined) return null;
  // An ETA is a hint: a malformed one is dropped, not a reason to drop the projection.
  const expected = typeof item.expectedSeconds === "number" && Number.isFinite(item.expectedSeconds) && item.expectedSeconds >= 0 &&
    typeof item.expectedSamples === "number" && Number.isSafeInteger(item.expectedSamples);
  return {
    id: item.id,
    type: item.type as OperationObservation["type"],
    status: "running",
    startedAt: item.startedAt,
    providerRef: item.providerRef,
    worldId,
    ...(expected ? { expectedSeconds: item.expectedSeconds as number, expectedSamples: item.expectedSamples as number } : {}),
  };
}

export function parseDynamicProjection(
  value: unknown,
  nowEpochMilliseconds: number,
  maxAgeMilliseconds = 10 * 60 * 1000,
): DynamicControlPlaneProjection | null {
  const item = object(value);
  if (item?.schema_version !== 1 || !Number.isSafeInteger(item.observed_at_epoch_ms) ||
      !Array.isArray(item.hosts) || !Array.isArray(item.operations)) return null;
  const observedAt = item.observed_at_epoch_ms as number;
  if (observedAt > nowEpochMilliseconds + 60_000 || nowEpochMilliseconds - observedAt > maxAgeMilliseconds) return null;
  const hosts = item.hosts.map(host);
  const operations = item.operations.map(operation);
  if (hosts.includes(null) || operations.includes(null)) return null;
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
  // Hosts launched for fleet worlds are not this safety net's concern.
  const configured = hosts.filter((host) => host.provenance !== "launched");
  if (configured.length !== 1 || configured[0]?.state !== "stopped" || operations.length !== 0) return null;
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
    instanceId: configured[0].providerRef,
  };
}

export function hostOwnsSession(record: unknown, hostId: string, sessionId: string): boolean {
  const hostRecord = object(record);
  if (hostRecord?.hostId !== hostId || !Array.isArray(hostRecord.reservations)) return false;
  return hostRecord.reservations.some((value) => object(value)?.sessionId === sessionId);
}

/** A Step Functions status change, as the projector reads it. */
export type ExecutionChange = Readonly<{ executionArn: string; status: string }>;

export function executionChange(event: ControlPlaneEvent): ExecutionChange | null {
  if (event.source !== "aws.states") return null;
  const detail = object(event.detail);
  if (detail === null || typeof detail.executionArn !== "string" || typeof detail.status !== "string") return null;
  return { executionArn: detail.executionArn, status: detail.status };
}

/**
 * The running list with the event's own word on its run. ListExecutions is
 * eventually consistent, so a run that has just ended can still be listed,
 * and one that has just started can be missing. An ended status is final;
 * a missing run is added only when a consistent read confirms it runs.
 */
export async function withExecutionChange(
  operations: readonly OperationObservation[],
  change: ExecutionChange | null,
  confirmRunning: (executionArn: string) => Promise<OperationObservation | null>,
): Promise<readonly OperationObservation[]> {
  if (change === null) return operations;
  const listed = operations.some((operation) => operation.providerRef === change.executionArn);
  if (change.status !== "RUNNING") return listed ? operations.filter((operation) => operation.providerRef !== change.executionArn) : operations;
  if (listed) return operations;
  const running = await confirmRunning(change.executionArn);
  return running === null ? operations : [running, ...operations].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
