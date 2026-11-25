import type { HostObservation, OperationObservation } from "./read-model.ts";
import type { WorldRecord } from "./world-registry.ts";

// Deleting a persistent host (ADR-0100): the rules, apart from any cloud API.

/** What the API reads of the host before it asks the machine to delete it. */
export type PersistentHostDisks = Readonly<{
  /** The host's own Name tag; only Spawnpoint's persistent host may be deleted. */
  name: string | null;
  /** Its EBS volumes other than the root, which termination deletes by itself. */
  dataVolumeIds: readonly string[];
}>;

export type HostDeletionRun = Readonly<{
  operationId: string;
  requestedBy: string;
  hostId: string;
  dataVolumeIds: readonly string[];
  snapshot: boolean;
}>;

/** The port the API deletes a host through. */
export type HostDeletion = Readonly<{
  /** The host's tag and data volumes; null when EC2 knows no such instance. */
  readDisks: (hostId: string) => Promise<PersistentHostDisks | null>;
  /** Starts the delete-host machine and answers the execution's id. */
  start: (run: HostDeletionRun) => Promise<string>;
}>;

export const PERSISTENT_HOST_NAME = "spawnpoint-game-host";

export type HostDeletionRefusal =
  | "unknown_host" | "host_is_launched" | "host_not_stopped" | "host_in_use" | "operation_in_progress" | "not_a_spawnpoint_host";

/**
 * Whether the host may be deleted now. A launched host is the fleet's to let
 * go. A persistent host holds every world placed on the persistent host, so
 * one active world with that placement keeps it; so does any running operation.
 */
export function hostDeletionRefusal(
  hostId: string,
  hosts: readonly HostObservation[],
  worlds: readonly WorldRecord[],
  operations: readonly OperationObservation[],
): HostDeletionRefusal | null {
  const host = hosts.find((candidate) => candidate.providerRef === hostId);
  if (host === undefined) return "unknown_host";
  if (host.provenance === "launched") return "host_is_launched";
  if (host.state !== "stopped") return "host_not_stopped";
  if (worlds.some((world) => world.status === "active" && world.placement === "configured")) return "host_in_use";
  if (operations.length > 0) return "operation_in_progress";
  return null;
}
