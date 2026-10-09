import { WARM_HOST_RETENTION_SECONDS, warmHostExpired, type HostRecord } from "./placement.ts";

export type FleetSweepAction = "none" | "drain" | "terminate" | "alarm";

function emptyHostAction(host: HostRecord, instanceState: string, nowEpochSeconds: number, graceSeconds: number, warmRetentionSeconds: number): FleetSweepAction {
  const age = nowEpochSeconds - host.updatedAtEpochSeconds;
  if (host.state === "terminating") return "terminate";
  // A stopped warm host can accept a new reservation. Never stop EC2 from a
  // stale read of that record; flag the mismatch for a person instead. Past
  // its retention the drain, not the sweep, decides to let it go.
  if (host.state === "stopped") {
    if (instanceState === "running") return age > 300 ? "alarm" : "none";
    return instanceState === "stopped" && warmHostExpired(host, nowEpochSeconds, warmRetentionSeconds) ? "drain" : "none";
  }
  if (host.state === "draining") {
    const drainingSince = host.drainingSinceEpochSeconds;
    return drainingSince !== null && nowEpochSeconds - drainingSince > graceSeconds + 300 ? "drain" : "none";
  }
  return age > 3600 ? "alarm" : "none";
}

/** Decide without side effects. The caller has already restricted EC2 to Fleet-tagged hosts. */
export function fleetSweepAction(
  instanceState: string,
  launchedAtEpochSeconds: number,
  host: HostRecord | null,
  nowEpochSeconds: number,
  graceSeconds: number,
  warmRetentionSeconds = WARM_HOST_RETENTION_SECONDS,
): FleetSweepAction {
  if (instanceState === "pending" || instanceState === "stopping") return "none";
  if (host === null) return nowEpochSeconds - launchedAtEpochSeconds > 3600 ? "alarm" : "none";
  if (host.provenance !== "launched") return "alarm";
  if (host.reservations.length > 0) {
    return instanceState === "stopped" ? "alarm" : "none";
  }
  return emptyHostAction(host, instanceState, nowEpochSeconds, graceSeconds, warmRetentionSeconds);
}
