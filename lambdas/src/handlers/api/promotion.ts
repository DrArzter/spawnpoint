import { randomUUID } from "node:crypto";

import { type Identity } from "../../access/domain.ts";
import { catalogWithPresets, gameCatalog } from "../../control-plane/catalog.ts";
import { planPromotion, type PromotionPlan } from "../../control-plane/promotion.ts";
import { checkReleaseUsable, noReleaseState } from "../../control-plane/release-usable.ts";
import type { SwitchOutcome, SwitchRequest } from "../../control-plane/release-switch.ts";
import { blockingOperations, sessionLifecycleKey } from "../../control-plane/world-session.ts";
import { type ControlPlaneSources } from "../../control-plane/read-model.ts";
import { type HostEnvKeys, missingGameSecrets } from "../../control-plane/launch-preflight.ts";
import { type SessionMachines } from "../../control-plane/session-machines.ts";
import { type WorldRecords } from "../../control-plane/world-records.ts";
import { parseJsonObject, response, type Response, errorResponse } from "./http.ts";
import { worldPlacements } from "./world-state.ts";

/** What a promotion needs, injected so that it depends on no cloud API. */
export type PromotionDependencies = Readonly<{
  sources: ControlPlaneSources;
  machines: Pick<SessionMachines, "promote">;
  worlds: Pick<WorldRecords, "switchReleaseBeforeFirstStart">;
  /** The host .env's names: a promotion starts the world on its host (ADR-0108). */
  hostEnv: HostEnvKeys;
}>;

export function promotionFeature({ sources, machines, worlds, hostEnv }: PromotionDependencies) {
  // Promote a fleet world's open wipe to another ready release of its preset
  // (ADR-0078), keeping its save. The promote-release machine saves, keeps the
  // pre-promotion backup, reconciles on the host placement gives the world,
  // starts, checks health and commits; on failure the previous release stays.
  // A wipe that never started has no save: its release is switched at once.
  async function promoteWorld(
    identity: Identity,
    gameId: string,
    worldId: string,
    body: string | undefined,
    switchRelease: (request: SwitchRequest) => Promise<SwitchOutcome> = worlds.switchReleaseBeforeFirstStart,
  ): Promise<Response> {
    const parsed = parseJsonObject({ body });
    if (parsed.startAfter !== undefined && typeof parsed.startAfter !== "boolean") return errorResponse(400, "invalid_start_after");
    // The world keeps running after its update and the idle watchdog stops it; false restores the old closing stop.
    const startAfter = parsed.startAfter !== false;
    const [hosts, allOperations, presets, worldRecords] = await Promise.all([
      sources.listHosts(),
      sources.listRunningOperations(),
      sources.listPresets?.() ?? Promise.resolve([]),
      sources.listWorldRecords?.() ?? Promise.resolve([]),
    ]);
    const record = worldRecords.find((candidate) => candidate.worldId === worldId);
    const serverId = sessionLifecycleKey(gameId, worldId, "fleet");
    const [pointer, session] = await Promise.all([
      sources.readReleasePointer(worldId, record?.currentGeneration.id ?? null),
      record?.placement === "fleet" ? sources.readLifecycle(serverId) : Promise.resolve(null),
    ]);
    // An archive can only exist for a wipe with no active release to ask about; the listing is skipped otherwise.
    const unstarted = pointer.state === "available" && pointer.activeRelease === null && pointer.generationId === record?.currentGeneration.id;
    const hasBackup = unstarted
      ? await (sources.hasGenerationBackup ?? (async () => true))(worldId, pointer.generationId as string)
      : false;
    const operations = blockingOperations(allOperations, worldId, worldPlacements(catalogWithPresets(presets, gameCatalog, worldRecords)));
    // The check runs for a well-formed release of a known world; the plan refuses the rest first.
    const releaseUsability = record !== undefined && typeof parsed.release === "string" && /^\d+\.\d+$/.test(parsed.release)
      ? await checkReleaseUsable(sources.readReleaseState ?? noReleaseState, gameId, record.preset.id, parsed.release)
      : "usable";
    const preset = presets.find((candidate) => candidate.gameId === gameId && candidate.id === record?.preset.id);
    const plan = planPromotion({
      gameId, release: parsed.release, record, releaseUsability, preset,
      pointer, session, hasBackup,
      blockingOperations: operations.length,
      launchEnabled: process.env.SPAWNPOINT_LAUNCH === "enabled",
    });
    if (plan.kind === "reject") return errorResponse(plan.status, plan.error);
    if (plan.kind === "switch") return switchResponse(plan, worldId, identity, switchRelease);
    const missing = await missingGameSecrets(hostEnv, gameId);
    if (missing.length > 0) return errorResponse(409, "missing_game_secrets", { keys: missing });
    const operationId = `panel-promote-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
    await machines.promote({
      operationId, serverId, gameId, presetId: plan.record.preset.id, worldId, worldName: plan.record.displayName,
      generationId: plan.record.currentGeneration.id, release: plan.release,
      policy: plan.record.warm === true ? "warm" : "cold",
      ...(plan.record.onDemand === true ? { market: "on-demand" as const } : {}),
      ...(preset?.footprint === undefined ? {} : { footprint: preset.footprint }),
      requestedBy: `identity:${identity.id}`, startAfter,
    });
    return response(202, { result: "requested", operationId, release: plan.release, previousRelease: plan.previous, startAfter });
  }

  return { promoteWorld };
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
  if (outcome === "conflict") return errorResponse(409, "world_changed");
  return response(200, { result: "switched", release: plan.release, previousRelease: plan.previous });
}
