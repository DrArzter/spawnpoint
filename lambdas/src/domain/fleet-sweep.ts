import type { HostRecord } from "./placement.ts";

export type FleetSweepAction = "none" | "drain" | "terminate" | "alarm";

/** Decide without side effects. The caller has already restricted EC2 to Fleet-tagged hosts. */
export function fleetSweepAction(
  instanceState: string,
  launchedAtEpochSeconds: number,
  host: HostRecord | null,
  nowEpochSeconds: number,
  graceSeconds: number,
): FleetSweepAction {
  if (instanceState === "pending" || instanceState === "stopping") return "none";
  if (host === null) return nowEpochSeconds - launchedAtEpochSeconds > 3600 ? "alarm" : "none";
  if (host.provenance !== "launched") return "alarm";
  if (host.reservations.length > 0) {
    return instanceState === "stopped" ? "alarm" : "none";
  }
  const age = nowEpochSeconds - host.updatedAtEpochSeconds;
  if (host.state === "terminating") return "terminate";
  // A stopped warm host can accept a new reservation. Never stop EC2 from a
  // stale read of that record; flag the mismatch for a person instead.
  if (host.state === "stopped") return instanceState === "running" && age > 300 ? "alarm" : "none";
  if (host.state === "draining") {
    const drainingSince = host.drainingSinceEpochSeconds;
    return drainingSince !== null && nowEpochSeconds - drainingSince > graceSeconds + 300 ? "drain" : "none";
  }
  return age > 3600 ? "alarm" : "none";
}
