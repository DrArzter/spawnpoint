import { awsControlPlaneSources } from "../../control-plane/aws.ts";
import { catalogWithPresets, gameCatalog } from "../../control-plane/catalog.ts";
import { type WorldPlacement } from "../../control-plane/world-session.ts";
import { type Response, response } from "./http.ts";
import { hostIdsOf, mergeWorldMetrics, worldHostRuns } from "../../control-plane/world-metrics.ts";
import { readWorldSession, locateWorldHost } from "./world-state.ts";

const METRIC_RANGES: Readonly<Record<string, number>> = { "6h": 6, "24h": 24, "7d": 168 };

// Host metrics come from CloudWatch rather than from the host, so they answer
// for a window the host did not survive: an instance that was stopped all night
// has no datapoints, and that gap is the answer to "was it running".
export async function hostMetrics(instanceId: string, range: string): Promise<Response> {
  if (!/^i-[0-9a-f]{8,32}$/.test(instanceId)) return response(400, { error: "invalid_instance_id" });
  const hours = METRIC_RANGES[range];
  if (hours === undefined) return response(400, { error: "invalid_range" });
  if (awsControlPlaneSources.readHostMetrics === undefined) return response(501, { error: "metrics_unavailable" });
  return response(200, { range, ...await awsControlPlaneSources.readHostMetrics(instanceId, hours) });
}

// A world's metrics are those of the hosts it ran on in the window (ADR-0062,
// ADR-0015). A fleet world gets a new host for each session, so the session
// history says which host to read for which stretch. A stopped world shows what
// it did; it answers 409 only when no session touched the window.
export async function worldMetrics(gameId: string, worldId: string, range: string): Promise<Response> {
  const hours = METRIC_RANGES[range];
  if (hours === undefined) return response(400, { error: "invalid_range" });
  const { readHostsMetrics, readWorldSessionHosts } = awsControlPlaneSources;
  if (readHostsMetrics === undefined || readWorldSessionHosts === undefined) return response(501, { error: "metrics_unavailable" });
  const [presets, worldRecords, hosts] = await Promise.all([
    awsControlPlaneSources.listPresets?.() ?? Promise.resolve([]),
    awsControlPlaneSources.listWorldRecords?.() ?? Promise.resolve([]),
    awsControlPlaneSources.listHosts(),
  ]);
  const world = catalogWithPresets(presets, gameCatalog, worldRecords)
    .find((game) => game.id === gameId)?.worlds.find((candidate) => candidate.id === worldId);
  if (world === undefined) return response(404, { error: "unknown_world" });
  const placement: WorldPlacement = world.placement === "fleet" ? "fleet" : "configured";
  const located = await readWorldSession(gameId, worldId, placement);
  const nowMs = Date.now();
  const windowStartMs = nowMs - hours * 3_600_000;
  const [current, entries] = await Promise.all([
    locateWorldHost(placement, located.record, hosts),
    readWorldSessionHosts(worldId, windowStartMs),
  ]);
  const record = located.record;
  const live = current === null ? null : {
    hostId: current.hostId,
    sessionId: record?.activeSessionId ?? null,
    startedAtMs: record?.readyAtEpochSeconds ? record.readyAtEpochSeconds * 1000 : nowMs,
  };
  const runs = worldHostRuns(entries, live, {
    windowStartMs,
    nowMs,
    unseenStopMs: record !== null && record.activeSessionId === null ? record.updatedAtEpochSeconds * 1000 : null,
  });
  if (runs.length === 0) return response(409, { error: "world_not_running" });
  const merged = mergeWorldMetrics(await readHostsMetrics(hostIdsOf(runs), hours), runs);
  return merged === null ? response(409, { error: "world_not_running" }) : response(200, { range, ...merged });
}
