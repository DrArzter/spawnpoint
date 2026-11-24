import { awsControlPlaneSources } from "../../control-plane/aws.ts";
import { catalogWithPresets, gameCatalog } from "../../control-plane/catalog.ts";
import { type WorldPlacement } from "../../control-plane/world-session.ts";
import { type Response, response, errorResponse } from "./http.ts";
import { hostIdsOf, mergeWorldMetrics, worldHostRuns } from "../../control-plane/world-metrics.ts";
import { readWorldSession, locateWorldHost } from "./world-state.ts";
import type { HostMetrics, MetricRange } from "../../../../contract/metrics.ts";
import { METRIC_RANGES as RANGES } from "../../../../contract/metrics.ts";

function metricRange(range: string): MetricRange | null {
  return Object.hasOwn(RANGES, range) ? range as MetricRange : null;
}


// Host metrics come from CloudWatch rather than from the host, so they answer
// for a window the host did not survive: an instance that was stopped all night
// has no datapoints, and that gap is the answer to "was it running".
export async function hostMetrics(instanceId: string, range: string): Promise<Response> {
  if (!/^i-[0-9a-f]{8,32}$/.test(instanceId)) return errorResponse(400, "invalid_instance_id");
  const named = metricRange(range);
  if (named === null) return errorResponse(400, "invalid_range");
  if (awsControlPlaneSources.readHostMetrics === undefined) return errorResponse(501, "metrics_unavailable");
  const body: HostMetrics = { range: named, ...await awsControlPlaneSources.readHostMetrics(instanceId, RANGES[named]) };
  return response(200, body);
}

// A world's metrics are those of the hosts it ran on in the window (ADR-0062,
// ADR-0015). A fleet world gets a new host for each session, so the session
// history says which host to read for which stretch. A stopped world shows what
// it did; it answers 409 only when no session touched the window.
export async function worldMetrics(gameId: string, worldId: string, range: string): Promise<Response> {
  const named = metricRange(range);
  if (named === null) return errorResponse(400, "invalid_range");
  const hours = RANGES[named];
  const { readHostsMetrics, readWorldSessionHosts } = awsControlPlaneSources;
  if (readHostsMetrics === undefined || readWorldSessionHosts === undefined) return errorResponse(501, "metrics_unavailable");
  const [presets, worldRecords, hosts] = await Promise.all([
    awsControlPlaneSources.listPresets?.() ?? Promise.resolve([]),
    awsControlPlaneSources.listWorldRecords?.() ?? Promise.resolve([]),
    awsControlPlaneSources.listHosts(),
  ]);
  const world = catalogWithPresets(presets, gameCatalog, worldRecords)
    .find((game) => game.id === gameId)?.worlds.find((candidate) => candidate.id === worldId);
  if (world === undefined) return errorResponse(404, "unknown_world");
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
  if (runs.length === 0) return errorResponse(409, "world_not_running");
  const merged = mergeWorldMetrics(await readHostsMetrics(hostIdsOf(runs), hours), runs);
  if (merged === null) return errorResponse(409, "world_not_running");
  const body: HostMetrics = { range: named, ...merged };
  return response(200, body);
}
