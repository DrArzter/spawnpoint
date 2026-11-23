import { randomUUID } from "node:crypto";

import { type Identity } from "../../access/domain.ts";
import { awsControlPlaneSources, promotionExecution, switchReleaseBeforeFirstStart } from "../../control-plane/aws.ts";
import { catalogWithPresets, gameCatalog } from "../../control-plane/catalog.ts";
import { planPromotion, type PromotionPlan } from "../../control-plane/promotion.ts";
import { checkReleaseUsable, noReleaseState } from "../../control-plane/release-usable.ts";
import type { SwitchOutcome, SwitchRequest } from "../../control-plane/release-switch.ts";
import { blockingOperations, sessionLifecycleKey } from "../../control-plane/world-session.ts";
import { parseJsonObject, response, type Response } from "./http.ts";
import { worldPlacements } from "./world-state.ts";

// Promote a fleet world's open wipe to another ready release of its preset
// (ADR-0078), keeping its save. The promote-release machine saves, keeps the
// pre-promotion backup, reconciles on the host placement gives the world,
// starts, checks health and commits; on failure the previous release stays.
// A wipe that never started has no save: its release is switched at once.
export async function promoteWorld(
  identity: Identity,
  gameId: string,
  worldId: string,
  body: string | undefined,
  switchRelease: (request: SwitchRequest) => Promise<SwitchOutcome> = switchReleaseBeforeFirstStart,
): Promise<Response> {
  const parsed = parseJsonObject({ body });
  if (parsed.startAfter !== undefined && typeof parsed.startAfter !== "boolean") return response(400, { error: "invalid_start_after" });
  // The world keeps running after its update and the idle watchdog stops it; false restores the old closing stop.
  const startAfter = parsed.startAfter !== false;
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
  // An archive can only exist for a wipe with no active release to ask about; the listing is skipped otherwise.
  const unstarted = pointer.state === "available" && pointer.activeRelease === null && pointer.generationId === record?.currentGeneration.id;
  const hasBackup = unstarted
    ? await (awsControlPlaneSources.hasGenerationBackup ?? (async () => true))(worldId, pointer.generationId as string)
    : false;
  const operations = blockingOperations(allOperations, worldId, worldPlacements(catalogWithPresets(presets, gameCatalog, worldRecords)));
  // The check runs for a well-formed release of a known world; the plan refuses the rest first.
  const releaseUsability = record !== undefined && typeof parsed.release === "string" && /^\d+\.\d+$/.test(parsed.release)
    ? await checkReleaseUsable(awsControlPlaneSources.readReleaseState ?? noReleaseState, gameId, record.preset.id, parsed.release)
    : "usable";
  const plan = planPromotion({
    gameId, release: parsed.release, record, releaseUsability,
    preset: presets.find((candidate) => candidate.gameId === gameId && candidate.id === record?.preset.id),
    pointer, session, hasBackup,
    blockingOperations: operations.length,
    launchEnabled: process.env.SPAWNPOINT_LAUNCH === "enabled",
    configuredHostId: hosts.find((candidate) => candidate.provenance !== "launched")?.providerRef,
  });
  if (plan.kind === "reject") return response(plan.status, { error: plan.error });
  if (plan.kind === "switch") return switchResponse(plan, worldId, identity, switchRelease);
  const operationId = `panel-promote-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  await promotionExecution({
    operationId, serverId, gameId, presetId: plan.record.preset.id, worldId, worldName: plan.record.displayName,
    generationId: plan.record.currentGeneration.id, release: plan.release, instanceId: plan.instanceId,
    policy: plan.record.warm === true ? "warm" : "cold", requestedBy: `identity:${identity.id}`, startAfter,
  });
  return response(202, { result: "requested", operationId, release: plan.release, previousRelease: plan.previous, startAfter });
}

// No workflow runs: the release is written before the answer.
async function switchResponse(
  plan: Extract<PromotionPlan, { kind: "switch" }>,
  worldId: string,
  identity: Identity,
  switchRelease: (request: SwitchRequest) => Promise<SwitchOutcome>,
): Promise<Response> {
  const outcome = await switchRelease({
    worldId, generationId: plan.record.currentGeneration.id, release: plan.release, updatedBy: `identity:${identity.id}`,
  });
  if (outcome === "conflict") return response(409, { error: "world_changed" });
  return response(200, { result: "switched", release: plan.release, previousRelease: plan.previous });
}
