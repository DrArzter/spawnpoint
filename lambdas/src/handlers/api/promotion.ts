import { randomUUID } from "node:crypto";

import { type Identity } from "../../access/domain.ts";
import { awsControlPlaneSources, promotionExecution } from "../../control-plane/aws.ts";
import { catalogWithPresets, gameCatalog } from "../../control-plane/catalog.ts";
import { planPromotion } from "../../control-plane/promotion.ts";
import { checkReleaseUsable, noReleaseState } from "../../control-plane/release-usable.ts";
import { blockingOperations, sessionLifecycleKey } from "../../control-plane/world-session.ts";
import { parseObjectBody, response, type Response } from "./http.ts";
import { worldPlacements } from "./world-state.ts";

// Promote a fleet world's open wipe to another ready release of its preset
// (ADR-0078), keeping its save. The promote-release machine saves, keeps the
// pre-promotion backup, reconciles on the host placement gives the world,
// starts, checks health and commits; on failure the previous release stays.
export async function promoteWorld(identity: Identity, gameId: string, worldId: string, body: string | undefined): Promise<Response> {
  const parsed = parseObjectBody(body);
  if (parsed === null) return response(400, { error: "invalid_json" });
  const [hosts, allOperations, presets, worldRecords] = await Promise.all([
    awsControlPlaneSources.listHosts(),
    awsControlPlaneSources.listRunningOperations(),
    awsControlPlaneSources.listPresets?.() ?? Promise.resolve([]),
    awsControlPlaneSources.listWorldRecords?.() ?? Promise.resolve([]),
  ]);
  const record = worldRecords.find((candidate) => candidate.worldId === worldId);
  const serverId = sessionLifecycleKey(gameId, worldId, "fleet");
  const [pointer, session] = await Promise.all([
    awsControlPlaneSources.readReleasePointer(worldId, record?.currentGeneration.id ?? null),
    record?.placement === "fleet" ? awsControlPlaneSources.readLifecycle(serverId) : Promise.resolve(null),
  ]);
  const operations = blockingOperations(allOperations, worldId, worldPlacements(catalogWithPresets(presets, gameCatalog, worldRecords)));
  // The check runs for a well-formed release of a known world; the plan refuses the rest first.
  const releaseUsability = record !== undefined && typeof parsed.release === "string" && /^\d+\.\d+$/.test(parsed.release)
    ? await checkReleaseUsable(awsControlPlaneSources.readReleaseState ?? noReleaseState, gameId, record.preset.id, parsed.release)
    : "usable";
  const plan = planPromotion({
    gameId, release: parsed.release, record, releaseUsability,
    preset: presets.find((candidate) => candidate.gameId === gameId && candidate.id === record?.preset.id),
    pointer, session,
    blockingOperations: operations.length,
    launchEnabled: process.env.SPAWNPOINT_LAUNCH === "enabled",
    configuredHostId: hosts.find((candidate) => candidate.provenance !== "launched")?.providerRef,
  });
  if (plan.kind === "reject") return response(plan.status, { error: plan.error });
  const operationId = `panel-promote-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  await promotionExecution({
    operationId, serverId, gameId, presetId: plan.record.preset.id, worldId, worldName: plan.record.displayName,
    generationId: plan.record.currentGeneration.id, release: plan.release, instanceId: plan.instanceId,
    policy: plan.record.warm === true ? "warm" : "cold", requestedBy: `identity:${identity.id}`,
  });
  return response(202, { result: "requested", operationId, release: plan.release, previousRelease: plan.previous });
}
