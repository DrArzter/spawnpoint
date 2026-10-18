import { type Identity } from "../../access/domain.ts";
import { type SessionAction, planFleetSessionOperation, planSessionOperation, stoppedHostRecoverySession, type SessionPlan } from "../../control-plane/session-control.ts";
import { awsControlPlaneSources, startSessionExecution, stopSessionExecution, materializePresetWorld, replaceWorldAccess, replaceWorldGameSettings, readWorldRecord, replaceWorldWhitelist, sendWhitelistReload, worldLifecycleExecution } from "../../control-plane/aws.ts";
import { catalogWithPresets, gameCatalog } from "../../control-plane/catalog.ts";
import { blockingOperations, sessionLifecycleKey, holdsWorld, type WorldPlacement } from "../../control-plane/world-session.ts";
import { randomUUID } from "node:crypto";
import { type WorldRecord, worldIdForName } from "../../control-plane/world-registry.ts";
import { checkGameSettings } from "../../control-plane/game-settings.ts";
import { checkWhitelist } from "../../control-plane/whitelist.ts";
import { type ControlPlaneSources } from "../../control-plane/read-model.ts";
import { type Response, response } from "./http.ts";
import { readWorldSession, worldPlacements, locateWorldHost } from "./world-state.ts";

export async function controlSession(identity: Identity, action: SessionAction, gameId: string, worldId: string): Promise<Response> {
  const [hosts, allOperations, presets, worldRecords] = await Promise.all([
    awsControlPlaneSources.listHosts(),
    awsControlPlaneSources.listRunningOperations(),
    awsControlPlaneSources.listPresets?.() ?? Promise.resolve([]),
    awsControlPlaneSources.listWorldRecords?.() ?? Promise.resolve([]),
  ]);
  const effectiveCatalog = catalogWithPresets(presets, gameCatalog, worldRecords);
  const world = effectiveCatalog.find((game) => game.id === gameId)?.worlds.find((candidate) => candidate.id === worldId);
  const fleet = world?.placement === "fleet";
  if (action === "start" && fleet && process.env.SPAWNPOINT_LAUNCH !== "enabled") return response(409, { error: "fleet_unavailable" });
  const located = await readWorldSession(gameId, worldId, fleet ? "fleet" : "configured");
  const operations = blockingOperations(allOperations, worldId, worldPlacements(effectiveCatalog));
  const configuredHosts = hosts.filter((candidate) => candidate.provenance !== "launched");
  const plan = fleet
    ? planFleetSessionOperation(gameId, worldId, action, operations, located.record, effectiveCatalog)
    : planSessionOperation(gameId, worldId, action, configuredHosts, operations, effectiveCatalog, located.record);
  if (plan.kind === "reject") return response(plan.reason === "unknown_world" ? 404 : 409, { error: plan.reason });
  const recoverySessionId = action === "stop" && !fleet ? stoppedHostRecoverySession(worldId, configuredHosts, located.record) : null;
  if (plan.kind === "noop" && recoverySessionId === null) return response(200, { result: plan.reason });
  const operationId = `panel-${action}-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const requestedBy = `identity:${identity.id}`;
  // The fleet workflow places the session itself. Its legacy instanceId input
  // is only a fallback for a missing placement, never a host selection.
  const hostId = fleet
    ? configuredHosts[0]?.providerRef
    : plan.kind === "execute" ? (plan as Extract<SessionPlan, { kind: "execute" }>).host.providerRef : configuredHosts[0]?.providerRef;
  if (!hostId) return response(409, { error: "configured_host_unavailable" });
  if (action === "start") {
    // No address in the request: the host's session summary answers with it
    // and the machine carries it back (ADR-0033). A new session always begins
    // on the record its placement names.
    await startSessionExecution({
      operationId, instanceId: hostId, requestedBy, gameId, worldId,
      serverId: sessionLifecycleKey(gameId, worldId, fleet ? "fleet" : "configured"),
      worldName: world?.displayName ?? worldId,
      placement: fleet ? "fleet" : "single",
    });
  }
  else {
    const activeSessionId = recoverySessionId ?? located.record?.activeSessionId;
    if (activeSessionId === null || activeSessionId === undefined) {
      return response(409, { error: "active_session_unavailable" });
    }
    await stopSessionExecution(operationId, hostId, requestedBy, located.serverId, activeSessionId, worldId);
  }
  return response(202, { result: "requested", operationId });
}

type WorldAccess = Readonly<{
  placement: WorldRecord["placement"];
  connectivity: WorldRecord["connectivity"];
  auth?: WorldRecord["auth"];
}>;

function parseWorldAccess(input: Readonly<{ placement?: unknown; connectivity?: unknown; auth?: unknown }>, useDefaults: boolean): WorldAccess | null {
  let placement = input.placement;
  if (placement === undefined && useDefaults) placement = process.env.SPAWNPOINT_PLACEMENT === "fleet" ? "fleet" : "configured";
  let connectivity = input.connectivity;
  if (connectivity === undefined && useDefaults) connectivity = placement === "fleet" ? "raw" : "zerotier";
  const auth = input.auth;
  if (placement !== "configured" && placement !== "fleet") return null;
  if (connectivity !== "zerotier" && connectivity !== "raw" && connectivity !== "route53") return null;
  if (auth !== undefined && auth !== "game" && auth !== "external") return null;
  if (connectivity !== "zerotier" && auth === undefined) return null;
  if (placement === "fleet" && (connectivity === "zerotier" || process.env.SPAWNPOINT_LAUNCH !== "enabled")) return null;
  if (placement === "configured" && connectivity !== "zerotier") return null;
  if (connectivity === "route53" && !process.env.GAME_DNS_SUFFIX) return null;
  return { placement, connectivity, ...(auth === undefined ? {} : { auth }) };
}

export async function createWorld(identity: Identity, gameId: string, presetId: string, body: string | undefined): Promise<Response> {
  let parsed: { displayName?: unknown; release?: unknown; placement?: unknown; connectivity?: unknown; auth?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const displayName = typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
  const release = typeof parsed.release === "string" ? parsed.release : "";
  if (displayName.length < 1 || displayName.length > 80) return response(400, { error: "invalid_world_name" });
  if (!/^[0-9]+\.[0-9]+$/.test(release)) return response(400, { error: "invalid_release" });
  const access = parseWorldAccess(parsed, true);
  if (access === null) return response(400, { error: "invalid_world_connectivity" });
  const presets = await (awsControlPlaneSources.listPresets?.() ?? Promise.resolve([]));
  const preset = presets.find((candidate) => candidate.gameId === gameId && candidate.id === presetId);
  if (preset === undefined) return response(404, { error: "unknown_preset" });
  if (preset.releases.length === 0) return response(409, { error: "preset_release_not_ready" });
  if (!preset.releases.includes(release)) return response(409, { error: "release_not_available" });
  const worldUuid = randomUUID();
  const worldId = worldIdForName(gameId, displayName, worldUuid);
  const createdAt = new Date().toISOString();
  const record = await materializePresetWorld(
    preset,
    { worldId, displayName, release },
    randomUUID(),
    createdAt,
    access,
  );
  return response(201, {
    world: {
      id: record.worldId,
      displayName: record.displayName,
      presetId: record.preset.id,
      generationId: record.currentGeneration.id,
      wipeNumber: 1,
      release: record.currentGeneration.release,
    },
    createdBy: identity.id,
  });
}

export async function updateWorldSettings(gameId: string, worldId: string, body: string | undefined): Promise<Response> {
  let parsed: { placement?: unknown; connectivity?: unknown; auth?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const access = parseWorldAccess(parsed, false);
  if (access === null) return response(400, { error: "invalid_world_connectivity" });
  // Only this world's own session holds its settings back (ADR-0062). Both
  // records are read, so the answer holds for either placement.
  const [game, own, operations] = await Promise.all([
    awsControlPlaneSources.readLifecycle(gameId),
    awsControlPlaneSources.readLifecycle(sessionLifecycleKey(gameId, worldId, "fleet")),
    awsControlPlaneSources.listRunningOperations(),
  ]);
  const unnamed = game !== null && game.activeWorldId == null && game.activeSessionId !== null;
  if (operations.some((operation) => operation.worldId === null || operation.worldId === worldId) ||
      holdsWorld(game, worldId) || holdsWorld(own, worldId) || unnamed) {
    return response(409, { error: "world_session_active" });
  }
  const result = await replaceWorldAccess(gameId, worldId, access);
  if (result === "missing") return response(404, { error: "unknown_world" });
  if (result === "conflict") return response(409, { error: "world_settings_conflict" });
  return response(200, { ...access, auth: access.auth ?? null });
}

// --- A world's game settings (ADR-0064) ----------------------------------------
// Saved whether or not the world runs: the host reads the record when a session
// starts, so a running game is never touched and takes them at its next start.
export async function updateGameSettings(identity: Identity, gameId: string, worldId: string, body: string | undefined): Promise<Response> {
  let parsed: { values?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const check = checkGameSettings(gameId, parsed.values);
  if (!check.ok) {
    return response(check.error === "game_has_no_settings" ? 409 : 400, { error: check.error, ...(check.setting === undefined ? {} : { setting: check.setting }) });
  }
  const gameSettings = {
    values: check.values,
    updatedAt: new Date().toISOString(),
    updatedBy: { identityId: identity.id, displayName: identity.displayName },
  };
  const result = await replaceWorldGameSettings(gameId, worldId, gameSettings);
  if (result === "missing") return response(404, { error: "unknown_world" });
  if (result === "archived") return response(409, { error: "world_archived" });
  if (result === "conflict") return response(409, { error: "world_settings_conflict" });
  return response(200, { values: gameSettings.values, updatedAt: gameSettings.updatedAt });
}

// --- A world's whitelist (ADR-0066) ---------------------------------------------
// Kept on the world record, so it follows the world to every host. A running
// world is asked to reload it at once; any start writes it anyway.

function gameKeepsWhitelist(gameId: string): boolean {
  return gameCatalog.find((game) => game.id === gameId)?.whitelist === true;
}

export async function whitelistOf(gameId: string, worldId: string): Promise<Response> {
  if (!gameKeepsWhitelist(gameId)) return response(409, { error: "game_has_no_whitelist" });
  const record = await readWorldRecord(worldId);
  if (record?.gameId !== gameId) return response(404, { error: "unknown_world" });
  return response(200, record.whitelist === undefined
    ? { managed: false, names: [], updatedAt: null, updatedBy: null }
    : { managed: true, names: record.whitelist.names, updatedAt: record.whitelist.updatedAt, updatedBy: record.whitelist.updatedBy.displayName });
}

export async function updateWhitelist(identity: Identity, gameId: string, worldId: string, body: string | undefined): Promise<Response> {
  let parsed: { names?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  if (!gameKeepsWhitelist(gameId)) return response(409, { error: "game_has_no_whitelist" });
  const check = checkWhitelist(parsed.names);
  if (!check.ok) return response(400, { error: check.error, ...(check.name === undefined ? {} : { name: check.name }) });
  const whitelist = {
    names: check.names,
    updatedAt: new Date().toISOString(),
    updatedBy: { identityId: identity.id, displayName: identity.displayName },
  };
  const result = await replaceWorldWhitelist(gameId, worldId, whitelist);
  if (result === "missing") return response(404, { error: "unknown_world" });
  if (result === "archived") return response(409, { error: "world_archived" });
  if (result === "conflict") return response(409, { error: "world_settings_conflict" });
  return response(200, { managed: true, names: whitelist.names, updatedAt: whitelist.updatedAt, applied: await reloadRunningWhitelist(gameId, worldId) });
}

// Fire and forget: the record is saved, and a host that cannot be asked now
// writes the list at the world's next start.
async function reloadRunningWhitelist(gameId: string, worldId: string): Promise<"reloading" | "next_start"> {
  try {
    const [presets, worldRecords, hosts] = await Promise.all([
      awsControlPlaneSources.listPresets?.() ?? Promise.resolve([]),
      awsControlPlaneSources.listWorldRecords?.() ?? Promise.resolve([]),
      awsControlPlaneSources.listHosts(),
    ]);
    const world = catalogWithPresets(presets, gameCatalog, worldRecords)
      .find((game) => game.id === gameId)?.worlds.find((candidate) => candidate.id === worldId);
    if (world === undefined) return "next_start";
    const placement: WorldPlacement = world.placement === "fleet" ? "fleet" : "configured";
    const located = await readWorldSession(gameId, worldId, placement);
    if (located.record?.observedState !== "ready") return "next_start";
    const host = await locateWorldHost(placement, located.record, hosts);
    if (host === null) return "next_start";
    await sendWhitelistReload({ hostId: host.hostId, worldId, slot: host.slot });
    return "reloading";
  } catch (error) {
    console.error(JSON.stringify({ event: "whitelist_reload_not_sent", worldId, error: error instanceof Error ? error.message : String(error) }));
    return "next_start";
  }
}

// A backup carries the generation it was taken from, and that generation names
// the release it ran. Restoring reinstates the pair, so a release that is no
// longer in the store makes the restored generation unstartable — and today the
// refusal would arrive at the next start, from reconciliation, with the world
// already repointed. It is checked here, where somebody is still looking at the
// button they pressed. See ADR-0052.
export async function restorableRelease(
  record: WorldRecord,
  backupKey: string,
  readManifest: ControlPlaneSources["readReleaseManifest"],
): Promise<"ok" | "unknown_generation" | "release_missing"> {
  const generationId = /-(gen-[0-9a-f]{32})-/.exec(backupKey)?.[1];
  if (generationId === undefined) return "unknown_generation";
  const generation = [record.currentGeneration, ...record.previousGenerations].find((candidate) => candidate.id === generationId);
  if (generation === undefined) return "unknown_generation";
  if (readManifest === undefined) return "ok";
  const manifest = await readManifest(record.gameId, record.preset.id, generation.release);
  return manifest === null ? "release_missing" : "ok";
}

export async function controlWorldLifecycle(
  identity: Identity,
  action: "archive" | "regenerate" | "restore" | "purge",
  gameId: string,
  worldId: string,
  body: string | undefined,
): Promise<Response> {
  let parsed: { backupKey?: unknown; confirmation?: unknown; release?: unknown } = {};
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const backupKey = action === "restore" && typeof parsed.backupKey === "string" ? parsed.backupKey : undefined;
  const release = action === "regenerate" && typeof parsed.release === "string" ? parsed.release : undefined;
  if (action === "restore" && (backupKey === undefined || !backupKey.startsWith(`worlds/${worldId}/archives/`))) {
    return response(400, { error: "invalid_backup_key" });
  }
  if (action === "purge" && parsed.confirmation !== worldId) return response(400, { error: "invalid_purge_confirmation" });
  if (action === "regenerate" && (release === undefined || !/^[0-9]+\.[0-9]+$/.test(release))) {
    return response(400, { error: "invalid_release" });
  }
  const [hosts, allOperations, presets, worldRecords] = await Promise.all([
    awsControlPlaneSources.listHosts(),
    awsControlPlaneSources.listRunningOperations(),
    awsControlPlaneSources.listPresets?.() ?? Promise.resolve([]),
    awsControlPlaneSources.listWorldRecords?.() ?? Promise.resolve([]),
  ]);
  const record = worldRecords.find((candidate) => candidate.gameId === gameId && candidate.worldId === worldId);
  if (record === undefined) return response(404, { error: "unknown_materialized_world" });
  const placement: WorldPlacement = record.placement === "fleet" ? "fleet" : "configured";
  const located = await readWorldSession(gameId, worldId, placement);
  const operations = blockingOperations(allOperations, worldId, worldPlacements(catalogWithPresets(presets, gameCatalog, worldRecords)));
  if (action === "purge" && record.status !== "archived") return response(409, { error: "world_not_archived" });
  if (action === "restore" && backupKey !== undefined) {
    const restorable = await restorableRelease(record, backupKey, awsControlPlaneSources.readReleaseManifest);
    if (restorable !== "ok") return response(409, { error: restorable });
  }
  if (operations.length > 0) return response(409, { error: "operation_in_progress" });
  const configuredHosts = hosts.filter((candidate) => candidate.provenance !== "launched");
  if (configuredHosts.length !== 1) return response(409, { error: "configured_host_unavailable" });
  const host = configuredHosts[0]!;
  if (record.placement !== "fleet" && (host.state === "pending" || host.state === "stopping" || host.state === "unknown")) {
    return response(409, { error: "host_transitioning" });
  }
  const operationId = `panel-world-${action}-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  // Only this world's own session is stopped first; another world of the
  // game keeps running. A configured host that runs while its game's record
  // names no session is running something nobody recorded: refuse, as before.
  if (placement === "configured" && record.status === "active" && host.state === "running" && located.record === null && located.game?.activeSessionId == null) {
    return response(409, { error: "active_session_unavailable" });
  }
  const stopRequired = record.status === "active" && located.record !== null;
  if (stopRequired && !located.record?.activeSessionId) return response(409, { error: "active_session_unavailable" });
  await worldLifecycleExecution(
    operationId, host.providerRef, `identity:${identity.id}`, located.serverId, located.record?.activeSessionId ?? "none", worldId, action, backupKey, release,
    stopRequired, record.currentGeneration.id,
  );
  return response(202, { result: "requested", operationId });
}
