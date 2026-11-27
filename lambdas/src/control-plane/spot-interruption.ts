import type { Footprint } from "../domain/placement.ts";
import { LifecycleConflict, beginMoving, type LifecycleRecord } from "../domain/lifecycle.ts";
import { PlacementConflict, markReclaimed, release } from "../domain/placement.ts";
import type { LifecycleStore } from "../lifecycle/coordinator.ts";
import type { SessionChangeNotifier } from "../lifecycle/session-changes.ts";
import type { PlacementStore } from "../lifecycle/placement-coordinator.ts";
import type { SessionVolumes } from "./session-volume-sweep.ts";
import { sessionLifecycleKey } from "./world-session.ts";

/*
 * A Spot interruption (ADR-0102), in two EC2 events about one launched host.
 *
 *   warning     every ready session on the host is marked moving, so the idle
 *               watchdog and a stop leave it alone while the host saves it
 *   terminated  each moving session leaves the dead host and starts again under
 *               its own id, with its session volume, in the zone the volume is in
 *
 * Every launched host is in the one public subnet, so the new host is in the
 * volume's zone. A session whose volume is gone starts again from its last S3
 * archive, as any start does.
 */

/** What the session's start was given, read back from its watchdog's input. */
export type SessionOrigin = Readonly<{ gameId: string; worldName: string }>;

export type SessionMove = Readonly<{
  operationId: string;
  serverId: string;
  sessionId: string;
  worldId: string;
  gameId: string;
  worldName: string;
  /** Empty when the session has no volume left: the start restores from S3. */
  volumeId: string;
  /** What the session was placed with, so the new host holds it as the old one did. */
  footprint: Footprint;
}>;

/** The port that starts a move: Start server V2 for the same session. */
export type SessionMoves = Readonly<{
  origin(watchdogExecutionId: string): Promise<SessionOrigin | null>;
  start(move: SessionMove): Promise<string>;
}>;

export type InterruptionPorts = Readonly<{
  placement: Pick<PlacementStore, "readHost" | "compareAndSetHost">;
  lifecycle: Pick<LifecycleStore, "read" | "compareAndSet">;
  volumes: Pick<SessionVolumes, "list">;
  moves: SessionMoves;
  /** Tells the panels a record changed; a ready world turns moving with no workflow running. */
  changed?: SessionChangeNotifier;
}>;

export type InterruptionResult = Readonly<{ hostId: string; worlds: string[]; skipped: string[] }>;

type Log = Pick<Console, "info" | "warn">;

const MAX_CAS_ATTEMPTS = 5;

/** Mark each ready session on a reclaimed Spot host as moving. */
export async function markHostSessionsMoving(
  ports: InterruptionPorts,
  hostId: string,
  nowEpochSeconds: number,
  log: Log,
): Promise<InterruptionResult> {
  const host = await ports.placement.readHost(hostId);
  if (host === null || host.record.provenance !== "launched") return { hostId, worlds: [], skipped: [] };
  await reclaimHost(ports, hostId, nowEpochSeconds);
  const worlds: string[] = [];
  const skipped: string[] = [];
  for (const reservation of host.record.reservations) {
    const serverId = sessionLifecycleKey(reservation.worldId, reservation.worldId, "fleet");
    const moved = await updateLifecycle(ports, serverId, (record) => beginMoving(record, reservation.sessionId, nowEpochSeconds));
    if (moved) {
      worlds.push(reservation.worldId);
      await ports.changed?.(serverId);
    }
    else {
      skipped.push(reservation.worldId);
      log.warn("session does not move", hostId, reservation.worldId, reservation.sessionId);
    }
  }
  return { hostId, worlds, skipped };
}

/** Start every moving session of a terminated host again on a new host. */
export async function moveHostSessions(
  ports: InterruptionPorts,
  hostId: string,
  nowEpochSeconds: number,
  log: Log,
): Promise<InterruptionResult> {
  const host = await ports.placement.readHost(hostId);
  if (host === null || host.record.provenance !== "launched") return { hostId, worlds: [], skipped: [] };
  await reclaimHost(ports, hostId, nowEpochSeconds);
  const volumes = await ports.volumes.list();
  const worlds: string[] = [];
  const skipped: string[] = [];
  for (const reservation of host.record.reservations) {
    const serverId = sessionLifecycleKey(reservation.worldId, reservation.worldId, "fleet");
    const current = await ports.lifecycle.read(serverId);
    const record = current?.record;
    if (record?.observedState !== "moving" || record.activeSessionId !== reservation.sessionId) {
      skipped.push(reservation.worldId);
      continue;
    }
    const origin = record.idle === null ? null : await ports.moves.origin(record.idle.watchdogExecutionId);
    await releaseReservation(ports, hostId, reservation.sessionId, nowEpochSeconds);
    const volumeId = volumes.find((volume) => volume.sessionId === reservation.sessionId)?.volumeId ?? "";
    await ports.moves.start({
      operationId: moveOperationId(reservation.sessionId, nowEpochSeconds),
      serverId,
      sessionId: reservation.sessionId,
      worldId: reservation.worldId,
      gameId: origin?.gameId ?? reservation.worldId,
      worldName: origin?.worldName ?? reservation.worldId,
      volumeId,
      footprint: reservation.footprint,
    });
    log.info("moving session", reservation.worldId, reservation.sessionId, volumeId || "from S3");
    worlds.push(reservation.worldId);
  }
  return { hostId, worlds, skipped };
}

/**
 * A Step Functions execution name, unique per move. It stays short because the
 * machines it starts append to it: the watchdog, then its idle stop, then that
 * stop's host stop (`-watchdog-idle-3-host-stop`), and a name may not exceed 80
 * characters. The whole session id did not fit (2026-11-27: every moved session
 * was impossible to stop).
 */
export function moveOperationId(sessionId: string, nowEpochSeconds: number): string {
  const short = sessionId.replace(/^session-/, "").replaceAll(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return `move-${nowEpochSeconds}-${short}`;
}

async function updateLifecycle(
  ports: InterruptionPorts,
  serverId: string,
  change: (record: LifecycleRecord) => LifecycleRecord,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await ports.lifecycle.read(serverId);
    if (current === null) return false;
    let next;
    try {
      next = change(current.record);
    } catch (error) {
      if (error instanceof LifecycleConflict) return false;
      throw error;
    }
    if (next === current.record) return true;
    if (await ports.lifecycle.compareAndSet(serverId, current.revision, next)) return true;
  }
  throw new Error(`lifecycle record ${serverId} kept changing`);
}

// The dead host lets the session go, so placement finds it nowhere and the
// new start reserves a fresh host. A session already released is not an error.
// No session may be placed on a host AWS is taking back, a moving one least of all.
async function reclaimHost(ports: InterruptionPorts, hostId: string, nowEpochSeconds: number): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await ports.placement.readHost(hostId);
    if (current === null) return;
    const next = markReclaimed(current.record, nowEpochSeconds);
    if (next === current.record) return;
    if (await ports.placement.compareAndSetHost(hostId, current.revision, next)) return;
  }
  throw new Error(`host record ${hostId} kept changing`);
}

async function releaseReservation(ports: InterruptionPorts, hostId: string, sessionId: string, nowEpochSeconds: number): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await ports.placement.readHost(hostId);
    if (current === null) return;
    let next;
    try {
      next = release(current.record, sessionId, nowEpochSeconds);
    } catch (error) {
      if (error instanceof PlacementConflict) return;
      throw error;
    }
    if (await ports.placement.compareAndSetHost(hostId, current.revision, next)) return;
  }
  throw new Error(`host record ${hostId} kept changing`);
}

export type InterruptionEvent =
  | Readonly<{ kind: "warning" | "terminated"; hostId: string }>
  | Readonly<{ kind: "saved"; hostId: string; report: Readonly<{ saved: string[]; failed: string[] }> }>;

const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** The three events the rules route here; anything else is ignored. */
export function interruptionEvent(event: unknown): InterruptionEvent | null {
  if (typeof event !== "object" || event === null) return null;
  const { source, "detail-type": detailType, detail } = event as Record<string, unknown>;
  if (typeof detail !== "object" || detail === null) return null;
  const fields = detail as Record<string, unknown>;
  if (source === "aws.ec2") {
    const hostId = fields["instance-id"];
    if (typeof hostId !== "string" || !INSTANCE_ID.test(hostId)) return null;
    if (detailType === "EC2 Spot Instance Interruption Warning") return { kind: "warning", hostId };
    if (detailType === "EC2 Instance State-change Notification" && fields.state === "terminated") return { kind: "terminated", hostId };
    return null;
  }
  // A host's own report is a record, never a command: nothing acts on it.
  if (source === "spawnpoint.host" && detailType === "Sessions saved for interruption") {
    const hostId = fields.instanceId;
    if (typeof hostId !== "string" || !INSTANCE_ID.test(hostId)) return null;
    return { kind: "saved", hostId, report: { saved: strings(fields.saved), failed: strings(fields.failed) } };
  }
  return null;
}
