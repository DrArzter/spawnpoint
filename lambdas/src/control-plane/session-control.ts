import type { HostObservation, OperationObservation, ReleasePointerObservation } from "./read-model.ts";
import { gameCatalog, type CatalogGame, type CatalogWorld } from "./catalog.ts";
import type { LifecycleRecord } from "../domain/lifecycle.ts";

export type SessionAction = "start" | "stop";

export function stoppedHostRecoverySession(
  worldId: string,
  hosts: readonly HostObservation[],
  lifecycle: LifecycleRecord | null,
): string | null {
  if (
    hosts.length !== 1 || hosts[0]?.state !== "stopped" ||
    lifecycle?.desiredState !== "stopped" || lifecycle.observedState !== "stopping" ||
    lifecycle.activeWorldId !== worldId
  ) return null;
  return lifecycle.activeSessionId;
}

export function worldLifecycleNeedsStop(worldStatus: "active" | "archived", hostState: HostObservation["state"]): boolean {
  return worldStatus === "active" && hostState === "running";
}
export type SessionPlan =
  | Readonly<{ kind: "execute"; host: HostObservation; world: CatalogWorld }>
  | Readonly<{ kind: "noop"; reason: "already_stopped" }>
  | Readonly<{
      kind: "reject";
      reason:
        | "unknown_world"
        | "unsupported_world"
        | "operation_in_progress"
        | "host_not_unique"
        | "host_transitioning"
        | "host_already_running";
    }>;

export type FleetSessionPlan =
  | Readonly<{ kind: "execute"; world: CatalogWorld }>
  | Readonly<{ kind: "noop"; reason: "already_stopped" }>
  | Readonly<{ kind: "reject"; reason: "unknown_world" | "unsupported_world" | "operation_in_progress" | "session_transitioning" | "world_not_active" | "active_session_unavailable" }>;

/** Fleet placement happens inside the start workflow, so zero or many EC2 hosts
 * are normal here. The lifecycle, not an arbitrary host, owns the stop. */
export function planFleetSessionOperation(
  gameId: string,
  worldId: string,
  action: SessionAction,
  operations: readonly OperationObservation[],
  lifecycle: LifecycleRecord | null,
  catalog: readonly CatalogGame[] = gameCatalog,
): FleetSessionPlan {
  const world = catalog.find((game) => game.id === gameId)?.worlds.find((candidate) => candidate.id === worldId);
  if (!world) return { kind: "reject", reason: "unknown_world" };
  if (world.sessionControl === null) return { kind: "reject", reason: "unsupported_world" };
  if (operations.length > 0) return { kind: "reject", reason: "operation_in_progress" };
  if (action === "start") {
    if (lifecycle?.activeSessionId || (lifecycle?.observedState !== undefined && lifecycle.observedState !== "stopped")) {
      return { kind: "reject", reason: "session_transitioning" };
    }
    return { kind: "execute", world };
  }
  if (lifecycle?.activeSessionId === null || lifecycle === null) return { kind: "noop", reason: "already_stopped" };
  if (lifecycle.activeWorldId !== worldId) return { kind: "reject", reason: "world_not_active" };
  if (!lifecycle.activeSessionId) return { kind: "reject", reason: "active_session_unavailable" };
  return { kind: "execute", world };
}

export function planSessionOperation(
  gameId: string,
  worldId: string,
  action: SessionAction,
  hosts: readonly HostObservation[],
  operations: readonly OperationObservation[],
  catalog: readonly CatalogGame[] = gameCatalog,
): SessionPlan {
  const world = catalog.find((game) => game.id === gameId)?.worlds.find((candidate) => candidate.id === worldId);
  if (!world) return { kind: "reject", reason: "unknown_world" };
  if (world.sessionControl === null) return { kind: "reject", reason: "unsupported_world" };
  if (operations.length > 0) return { kind: "reject", reason: "operation_in_progress" };
  if (hosts.length !== 1) return { kind: "reject", reason: "host_not_unique" };
  const host = hosts[0]!;
  if (action === "stop" && host.state === "stopped") return { kind: "noop", reason: "already_stopped" };
  if (host.state === "pending" || host.state === "stopping" || host.state === "unknown") {
    return { kind: "reject", reason: "host_transitioning" };
  }
  // A start now names its world, so the machines can run any of them — but the
  // host state alone does not say which world is up, and a second game beside a
  // running one is memory nobody has measured (ADR-0023 keeps one world active
  // at a time until that changes). Refuse rather than quietly co-tenant.
  if (action === "start" && host.state === "running") return { kind: "reject", reason: "host_already_running" };
  return { kind: "execute", host, world };
}

export type PackChoice =
  | Readonly<{ kind: "release"; release: string }>
  | Readonly<{ kind: "none"; reason: "no_release_pointer" | "no_release_selected" }>;

// Which release a player should be handed the files for. The active release is
// what the server is actually running; a desired one that has not been through
// a start is what it will run next, and offering that instead would hand out a
// pack for a world nobody is playing yet. So: active first, desired only when
// nothing is active.
export function packRelease(pointer: ReleasePointerObservation | null): PackChoice {
  if (pointer === null || pointer.state !== "available") return { kind: "none", reason: "no_release_pointer" };
  const release = pointer.activeRelease ?? pointer.desiredRelease;
  return release === null ? { kind: "none", reason: "no_release_selected" } : { kind: "release", release };
}
