import type { HostObservation, OperationObservation } from "./read-model.ts";
import { gameCatalog, type CatalogGame } from "./catalog.ts";

export type SessionAction = "start" | "stop";
export type SessionPlan =
  | Readonly<{ kind: "execute"; host: HostObservation }>
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
  return { kind: "execute", host };
}
