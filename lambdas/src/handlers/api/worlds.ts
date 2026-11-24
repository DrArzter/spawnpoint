import { type Identity } from "../../access/domain.ts";
import { type SessionMachines } from "../../control-plane/session-machines.ts";
import { type WorldRecords } from "../../control-plane/world-records.ts";
import { type SessionAction, planFleetSessionOperation, planSessionOperation, stoppedHostRecoverySession, type SessionPlan, type FleetSessionPlan } from "../../control-plane/session-control.ts";
import { catalogWithPresets, gameCatalog } from "../../control-plane/catalog.ts";
import { usableByNewWipe } from "../../control-plane/preset-catalog.ts";
import { checkReleaseUsable, noReleaseState, type ReleaseStateReader, type ReleaseUsability } from "../../control-plane/release-usable.ts";
import { blockingOperations, sessionLifecycleKey, holdsWorld, type WorldHost, type WorldPlacement } from "../../control-plane/world-session.ts";
import { randomUUID } from "node:crypto";
import { type WorldRecord, worldIdForName } from "../../control-plane/world-registry.ts";
import { checkGameSettings } from "../../control-plane/game-settings.ts";
import { checkWhitelist, parseServerWhitelist, type WhitelistRules } from "../../control-plane/whitelist.ts";
import { findGameModule } from "../../control-plane/game-modules.ts";
import { consoleResult, encodeConsoleCommand, type ConsoleGateway } from "../../control-plane/console.ts";
import { type ControlPlaneSources } from "../../control-plane/read-model.ts";
import { backupGenerationId, resolveBackupRelease, type BackupReleaseSources } from "../../control-plane/backup-release.ts";
import { type Response, response, parseJsonObject, errorResponse } from "./http.ts";
import { requirePermission } from "./permissions.ts";
import { type StopPlayersPolicy } from "../../domain/telegram-bot.ts";
import { readWorldSession, worldPlacements, locateWorldHost } from "./world-state.ts";

/**
 * A stop's body may ask to disconnect players online. That escalation depends
 * on the payload, so it is checked here rather than by the route.
 */
function stopPlayersPolicy(identity: Identity, body: string | undefined): StopPlayersPolicy | Response {
  const request = parseJsonObject({ body });
  const players = request.players ?? "refuse";
  if (players !== "refuse" && players !== "disconnect") return errorResponse(400, "invalid_players");
  if (players === "disconnect") {
    const forbidden = requirePermission(identity, "session.stop.force");
    if (forbidden) return forbidden;
  }
  return players;
}

type SessionExecution = Readonly<{
  identity: Identity;
  action: SessionAction;
  gameId: string;
  worldId: string;
  worldName: string;
  fleet: boolean;
  warm: boolean;
  plan: SessionPlan | FleetSessionPlan;
  configuredHosts: readonly Readonly<{ providerRef: string }>[];
  located: Awaited<ReturnType<typeof readWorldSession>>;
  recoverySessionId: string | null;
  players: StopPlayersPolicy;
}>;

function plannedSessionHost(request: SessionExecution): string | undefined {
  if (!request.fleet && request.plan.kind === "execute" && "host" in request.plan) return request.plan.host.providerRef;
  return request.configuredHosts[0]?.providerRef;
}

type WorldAccess = Readonly<{
  placement: WorldRecord["placement"];
  connectivity: WorldRecord["connectivity"];
  auth?: WorldRecord["auth"];
}>;

type WorldAccessInput = Readonly<{ placement?: unknown; connectivity?: unknown; auth?: unknown }>;

function worldAccessDefaults(input: WorldAccessInput, useDefaults: boolean): WorldAccessInput {
  let placement = input.placement;
  if (placement === undefined && useDefaults) placement = process.env.SPAWNPOINT_PLACEMENT === "fleet" ? "fleet" : "configured";
  let connectivity = input.connectivity;
  if (connectivity === undefined && useDefaults) connectivity = placement === "fleet" ? "raw" : "zerotier";
  return { placement, connectivity, auth: input.auth };
}

function deploymentSupportsWorldAccess(placement: WorldAccess["placement"], connectivity: WorldAccess["connectivity"]): boolean {
  if (placement === "fleet" && (connectivity === "zerotier" || process.env.SPAWNPOINT_LAUNCH !== "enabled")) return false;
  if (placement === "configured" && connectivity !== "zerotier") return false;
  if (connectivity === "route53" && !process.env.GAME_DNS_SUFFIX) return false;
  return true;
}

function parseWorldAccess(input: WorldAccessInput, useDefaults: boolean): WorldAccess | null {
  const { placement, connectivity, auth } = worldAccessDefaults(input, useDefaults);
  if (placement !== "configured" && placement !== "fleet") return null;
  if (connectivity !== "zerotier" && connectivity !== "raw" && connectivity !== "route53") return null;
  if (auth !== undefined && auth !== "game" && auth !== "external") return null;
  if (connectivity !== "zerotier" && auth === undefined) return null;
  if (!deploymentSupportsWorldAccess(placement, connectivity)) return null;
  return { placement, connectivity, ...(auth === undefined ? {} : { auth }) };
}

// --- A world's whitelist (ADR-0066) ---------------------------------------------
// Kept on the world record, so it follows the world to every host. A running
// world is asked to reload it at once; any start writes it anyway.

/** The game's whitelist rules, when it keeps a whitelist (ADR-0090). */
function whitelistRulesOf(gameId: string): WhitelistRules | null {
  const module = findGameModule(gameId);
  return module?.whitelist === true ? module.whitelistRules : null;
}

// The read goes through the console gateway's document (ADR-0063) but is not a
// console command: nothing is recorded, so the history shows only what people ran.
const SERVER_READ_POLL_MS = 800;
// The API Lambda answers within ten seconds; the window leaves room for the lookups before it.
const SERVER_READ_WINDOW_MS = 5600;

// A backup is restored onto the release it ran (ADR-0052): the release the
// host recorded on the archive, else the release its wipe ran at that time,
// else the wipe's origin. A release that is no longer in the store makes the
// restored generation unstartable, and the refusal would otherwise arrive at
// the next start, with the world already repointed. It is checked here, where
// somebody is still looking at the button they pressed.
export async function restorableRelease(
  record: WorldRecord,
  backupKey: string,
  readManifest: ControlPlaneSources["readReleaseManifest"],
  sources?: BackupReleaseSources,
  readState: ReleaseStateReader = noReleaseState,
): Promise<"ok" | "unknown_generation" | "unknown_backup" | "release_missing" | Exclude<ReleaseUsability, "usable">> {
  const generationId = backupGenerationId(backupKey);
  const generation = [record.currentGeneration, ...record.previousGenerations].find((candidate) => candidate.id === generationId);
  if (generation === undefined) return "unknown_generation";
  const ran = sources === undefined ? generation.release : await resolveBackupRelease(record, backupKey, sources);
  if (ran === "unknown_generation" || ran === "unknown_backup") return ran;
  if (readManifest === undefined) return "ok";
  const release = typeof ran === "string" ? ran : ran.release;
  const manifest = await readManifest(record.gameId, record.preset.id, release);
  if (manifest === null) return "release_missing";
  const usability = await checkReleaseUsable(readState, record.gameId, record.preset.id, release);
  return usability === "usable" ? "ok" : usability;
}

type WorldLifecycleAction = "archive" | "regenerate" | "restore" | "purge";
type LifecycleInput =
  | Readonly<{ value: { backupKey: string | undefined; release: string | undefined }; error: null }>
  | Readonly<{ value: null; error: Response }>;

function lifecycleInput(action: WorldLifecycleAction, worldId: string, body: string | undefined): LifecycleInput {
  const parsed = parseJsonObject({ body });
  const backupKey = action === "restore" && typeof parsed.backupKey === "string" ? parsed.backupKey : undefined;
  const release = action === "regenerate" && typeof parsed.release === "string" ? parsed.release : undefined;
  if (action === "restore" && !backupKey?.startsWith(`worlds/${worldId}/archives/`)) {
    return { value: null, error: errorResponse(400, "invalid_backup_key") };
  }
  if (action === "purge" && parsed.confirmation !== worldId) return { value: null, error: errorResponse(400, "invalid_purge_confirmation") };
  if (action === "regenerate" && (release === undefined || !/^\d+\.\d+$/.test(release))) {
    return { value: null, error: errorResponse(400, "invalid_release") };
  }
  return { value: { backupKey, release }, error: null };
}

function lifecycleSessionError(
  record: WorldRecord,
  host: Awaited<ReturnType<ControlPlaneSources["listHosts"]>>[number],
  located: Awaited<ReturnType<typeof readWorldSession>>,
): Response | null {
  if (record.placement !== "fleet" && (host.state === "pending" || host.state === "stopping" || host.state === "unknown")) {
    return errorResponse(409, "host_transitioning");
  }
  // Refuse an untracked configured session; never stop another world's game.
  const configured = record.placement !== "fleet";
  if (configured && record.status === "active" && host.state === "running" && located.record === null && located.game?.activeSessionId == null) {
    return errorResponse(409, "active_session_unavailable");
  }
  const stopRequired = record.status === "active" && located.record !== null;
  if (stopRequired && !located.record?.activeSessionId) return errorResponse(409, "active_session_unavailable");
  return null;
}

/** What the world operations need, injected so that they depend on no cloud API. */
export type WorldsDependencies = Readonly<{
  sources: ControlPlaneSources;
  worlds: WorldRecords;
  machines: SessionMachines;
  gateway: Pick<ConsoleGateway, "send" | "read" | "reloadWhitelist">;
  backupReleases: () => BackupReleaseSources;
}>;

export function worldsFeature({ sources, worlds, machines, gateway, backupReleases }: WorldsDependencies) {
  async function controlSession(identity: Identity, action: SessionAction, gameId: string, worldId: string, body?: string): Promise<Response> {
    const players = action === "stop" ? stopPlayersPolicy(identity, body) : "refuse";
    if (typeof players !== "string") return players;
    const [hosts, allOperations, presets, worldRecords] = await Promise.all([
      sources.listHosts(),
      sources.listRunningOperations(),
      sources.listPresets?.() ?? Promise.resolve([]),
      sources.listWorldRecords?.() ?? Promise.resolve([]),
    ]);
    const effectiveCatalog = catalogWithPresets(presets, gameCatalog, worldRecords);
    const world = effectiveCatalog.find((game) => game.id === gameId)?.worlds.find((candidate) => candidate.id === worldId);
    const fleet = world?.placement === "fleet";
    if (action === "start" && fleet && process.env.SPAWNPOINT_LAUNCH !== "enabled") return errorResponse(409, "fleet_unavailable");
    const located = await readWorldSession(gameId, worldId, fleet ? "fleet" : "configured");
    const operations = blockingOperations(allOperations, worldId, worldPlacements(effectiveCatalog));
    const configuredHosts = hosts.filter((candidate) => candidate.provenance !== "launched");
    const plan = fleet
      ? planFleetSessionOperation(gameId, worldId, action, operations, located.record, effectiveCatalog)
      : planSessionOperation(gameId, worldId, action, configuredHosts, operations, effectiveCatalog, located.record);
    if (plan.kind === "reject") return errorResponse(plan.reason === "unknown_world" ? 404 : 409, plan.reason);
    const recoverySessionId = action === "stop" && !fleet ? stoppedHostRecoverySession(worldId, configuredHosts, located.record) : null;
    if (plan.kind === "noop" && recoverySessionId === null) return response(200, { result: plan.reason });
    // A fleet world kept warm asks placement to keep its launched host after the stop (ADR-0048).
    const warm = fleet && worldRecords.find((record) => record.worldId === worldId)?.warm === true;
    return executeSessionOperation({ identity, action, gameId, worldId, worldName: world?.displayName ?? worldId, fleet, warm, plan, configuredHosts, located, recoverySessionId, players });
  }

  async function executeSessionOperation(request: SessionExecution): Promise<Response> {
    const { identity, action, gameId, worldId, worldName, fleet, warm, located, recoverySessionId, players } = request;
    const operationId = `panel-${action}-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
    const requestedBy = `identity:${identity.id}`;
    // The fleet workflow places the session itself. Its legacy instanceId input
    // is only a fallback for a missing placement, never a host selection.
    const hostId = plannedSessionHost(request);
    if (!hostId) return errorResponse(409, "configured_host_unavailable");
    if (action === "start") {
      // No address in the request: the host's session summary answers with it
      // and the machine carries it back (ADR-0033). A new session always begins
      // on the record its placement names.
      await machines.start({
        operationId, instanceId: hostId, requestedBy, gameId, worldId,
        serverId: sessionLifecycleKey(gameId, worldId, fleet ? "fleet" : "configured"),
        worldName,
        placement: fleet ? "fleet" : "single",
        ...(fleet ? { policy: warm ? "warm" as const : "cold" as const } : {}),
      });
    }
    else {
      const activeSessionId = recoverySessionId ?? located.record?.activeSessionId;
      if (activeSessionId === null || activeSessionId === undefined) {
        return errorResponse(409, "active_session_unavailable");
      }
      await machines.stop({ operationId, instanceId: hostId, requestedBy, serverId: located.serverId, sessionId: activeSessionId, worldId, players });
    }
    return response(202, { result: "requested", operationId });
  }

  async function createWorld(identity: Identity, gameId: string, presetId: string, body: string | undefined): Promise<Response> {
    const parsed = parseJsonObject({ body });
    const displayName = typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
    const release = typeof parsed.release === "string" ? parsed.release : "";
    if (displayName.length < 1 || displayName.length > 80) return errorResponse(400, "invalid_world_name");
    if (!/^\d+\.\d+$/.test(release)) return errorResponse(400, "invalid_release");
    const access = parseWorldAccess(parsed, true);
    if (access === null) return errorResponse(400, "invalid_world_connectivity");
    const presets = await (sources.listPresets?.() ?? Promise.resolve([]));
    const preset = presets.find((candidate) => candidate.gameId === gameId && candidate.id === presetId);
    if (preset === undefined) return errorResponse(404, "unknown_preset");
    if (preset.releases.length === 0) return errorResponse(409, "preset_release_not_ready");
    if (!preset.releases.includes(release)) return errorResponse(409, "release_not_available");
    if (!usableByNewWipe(preset, release)) return errorResponse(409, "release_outdated");
    const usability = await checkReleaseUsable(sources.readReleaseState ?? noReleaseState, gameId, presetId, release);
    if (usability !== "usable") return errorResponse(409, usability);
    const worldUuid = randomUUID();
    const worldId = worldIdForName(gameId, displayName, worldUuid);
    const createdAt = new Date().toISOString();
    const record = await worlds.materialize(
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

  async function updateWorldSettings(gameId: string, worldId: string, body: string | undefined): Promise<Response> {
    const parsed = parseJsonObject({ body });
    const access = parseWorldAccess(parsed, false);
    if (access === null) return errorResponse(400, "invalid_world_connectivity");
    // Left out, the world keeps its choice. Only a launched host can be kept warm (ADR-0048).
    const { warm } = parsed;
    if ((warm !== undefined && typeof warm !== "boolean") || (warm === true && access.placement !== "fleet")) {
      return errorResponse(400, "invalid_world_warm");
    }
    // Only this world's own session holds its settings back (ADR-0062). Both
    // records are read, so the answer holds for either placement.
    const [game, own, operations] = await Promise.all([
      sources.readLifecycle(gameId),
      sources.readLifecycle(sessionLifecycleKey(gameId, worldId, "fleet")),
      sources.listRunningOperations(),
    ]);
    const unnamed = game !== null && game.activeWorldId == null && game.activeSessionId !== null;
    if (operations.some((operation) => operation.worldId === null || operation.worldId === worldId) ||
        holdsWorld(game, worldId) || holdsWorld(own, worldId) || unnamed) {
      return errorResponse(409, "world_session_active");
    }
    const hosting = warm === undefined ? access : { ...access, warm };
    const result = await worlds.replaceAccess(gameId, worldId, hosting);
    if (result === "missing") return errorResponse(404, "unknown_world");
    if (result === "conflict") return errorResponse(409, "world_settings_conflict");
    return response(200, { ...hosting, auth: access.auth ?? null });
  }

  // --- A world's game settings (ADR-0064) ----------------------------------------
  // Saved whether or not the world runs: the host reads the record when a session
  // starts, so a running game is never touched and takes them at its next start.
  async function updateGameSettings(identity: Identity, gameId: string, worldId: string, body: string | undefined): Promise<Response> {
    const parsed = parseJsonObject({ body });
    const check = checkGameSettings(gameId, parsed.values);
    if (!check.ok) {
      return errorResponse(check.error === "game_has_no_settings" ? 409 : 400, check.error, check.setting === undefined ? {} : { setting: check.setting });
    }
    const gameSettings = {
      values: check.values,
      updatedAt: new Date().toISOString(),
      updatedBy: { identityId: identity.id, displayName: identity.displayName },
    };
    const result = await worlds.replaceGameSettings(gameId, worldId, gameSettings);
    if (result === "missing") return errorResponse(404, "unknown_world");
    if (result === "archived") return errorResponse(409, "world_archived");
    if (result === "conflict") return errorResponse(409, "world_settings_conflict");
    return response(200, { values: gameSettings.values, updatedAt: gameSettings.updatedAt });
  }

  async function whitelistOf(gameId: string, worldId: string): Promise<Response> {
    if (whitelistRulesOf(gameId) === null) return errorResponse(409, "game_has_no_whitelist");
    const record = await worlds.read(worldId);
    if (record?.gameId !== gameId) return errorResponse(404, "unknown_world");
    if (record.whitelist !== undefined) {
      return response(200, { managed: true, names: record.whitelist.names, updatedAt: record.whitelist.updatedAt, updatedBy: record.whitelist.updatedBy.displayName });
    }
    // No list of its own: show the running server's, so adding a name keeps those players.
    const names = await readServerWhitelist(gameId, worldId);
    if (names === null) return errorResponse(502, "whitelist_unreadable");
    return response(200, { managed: false, names, updatedAt: null, updatedBy: null });
  }

  /**
   * The names a running server's own whitelist holds: [] when the world has no
   * running session or its game cannot list. Null when the host did not answer
   * with a list in time. A caller must not treat null as empty, because saving
   * from an empty list would drop the server's players.
   */
  async function readServerWhitelist(gameId: string, worldId: string, pollMs = SERVER_READ_POLL_MS): Promise<readonly string[] | null> {
    const rules = whitelistRulesOf(gameId);
    const command = rules?.listCommand ?? null;
    if (rules === null || command === null) return [];
    try {
      const host = await runningWorldHost(gameId, worldId);
      if (host === null) return [];
      const commandId = await gateway.send({ hostId: host.hostId, worldId, slot: host.slot }, encodeConsoleCommand(command));
      for (let waited = 0; waited < SERVER_READ_WINDOW_MS; waited += pollMs) {
        await new Promise((resolve) => setTimeout(resolve, pollMs)); // NOSONAR each poll waits on the host, in order
        const result = consoleResult(await gateway.read(commandId, host.hostId)); // NOSONAR each poll waits on the host, in order
        if (result.status === "pending") continue;
        return result.status === "succeeded" ? parseServerWhitelist(result.output ?? "", rules) : null;
      }
      return null;
    } catch (error) {
      console.error(JSON.stringify({ event: "server_whitelist_not_read", worldId, error: error instanceof Error ? error.message : String(error) }));
      return null;
    }
  }

  /** The host and slot of a world's ready session; null when it has none. */
  async function runningWorldHost(gameId: string, worldId: string): Promise<WorldHost | null> {
    const [presets, worldRecords, hosts] = await Promise.all([
      sources.listPresets?.() ?? Promise.resolve([]),
      sources.listWorldRecords?.() ?? Promise.resolve([]),
      sources.listHosts(),
    ]);
    const world = catalogWithPresets(presets, gameCatalog, worldRecords)
      .find((game) => game.id === gameId)?.worlds.find((candidate) => candidate.id === worldId);
    if (world === undefined) return null;
    const placement: WorldPlacement = world.placement === "fleet" ? "fleet" : "configured";
    const located = await readWorldSession(gameId, worldId, placement);
    if (located.record?.observedState !== "ready") return null;
    return locateWorldHost(placement, located.record, hosts);
  }

  async function updateWhitelist(identity: Identity, gameId: string, worldId: string, body: string | undefined): Promise<Response> {
    const parsed = parseJsonObject({ body });
    const rules = whitelistRulesOf(gameId);
    if (rules === null) return errorResponse(409, "game_has_no_whitelist");
    const check = checkWhitelist(parsed.names, rules);
    if (!check.ok) {
      const detail = check.error === "invalid_player_name" ? { name: check.name, hint: rules.nameHint } : check.name === undefined ? {} : { name: check.name };
      return errorResponse(400, check.error, detail);
    }
    const whitelist = {
      names: check.names,
      updatedAt: new Date().toISOString(),
      updatedBy: { identityId: identity.id, displayName: identity.displayName },
    };
    const result = await worlds.replaceWhitelist(gameId, worldId, whitelist);
    if (result === "missing") return errorResponse(404, "unknown_world");
    if (result === "archived") return errorResponse(409, "world_archived");
    if (result === "conflict") return errorResponse(409, "world_settings_conflict");
    return response(200, { managed: true, names: whitelist.names, updatedAt: whitelist.updatedAt, applied: await reloadRunningWhitelist(gameId, worldId) });
  }

  // Fire and forget: the record is saved, and a host that cannot be asked now
  // writes the list at the world's next start.
  async function reloadRunningWhitelist(gameId: string, worldId: string): Promise<"reloading" | "next_start"> {
    try {
      const host = await runningWorldHost(gameId, worldId);
      if (host === null) return "next_start";
      await gateway.reloadWhitelist({ hostId: host.hostId, worldId, slot: host.slot });
      return "reloading";
    } catch (error) {
      console.error(JSON.stringify({ event: "whitelist_reload_not_sent", worldId, error: error instanceof Error ? error.message : String(error) }));
      return "next_start";
    }
  }

  async function controlWorldLifecycle(
    identity: Identity,
    action: WorldLifecycleAction,
    gameId: string,
    worldId: string,
    body: string | undefined,
  ): Promise<Response> {
    const input = lifecycleInput(action, worldId, body);
    if (input.error !== null) return input.error;
    const { backupKey, release } = input.value;
    const [hosts, allOperations, presets, worldRecords] = await Promise.all([
      sources.listHosts(),
      sources.listRunningOperations(),
      sources.listPresets?.() ?? Promise.resolve([]),
      sources.listWorldRecords?.() ?? Promise.resolve([]),
    ]);
    const record = worldRecords.find((candidate) => candidate.gameId === gameId && candidate.worldId === worldId);
    if (record === undefined) return errorResponse(404, "unknown_materialized_world");
    const placement: WorldPlacement = record.placement === "fleet" ? "fleet" : "configured";
    const located = await readWorldSession(gameId, worldId, placement);
    const operations = blockingOperations(allOperations, worldId, worldPlacements(catalogWithPresets(presets, gameCatalog, worldRecords)));
    if (action === "purge" && record.status !== "archived") return errorResponse(409, "world_not_archived");
    if (action === "restore" && backupKey !== undefined) {
      const restorable = await restorableRelease(record, backupKey, sources.readReleaseManifest, backupReleases(), sources.readReleaseState);
      if (restorable !== "ok") return errorResponse(409, restorable);
    }
    if (operations.length > 0) return errorResponse(409, "operation_in_progress");
    const configuredHosts = hosts.filter((candidate) => candidate.provenance !== "launched");
    if (configuredHosts.length !== 1) return errorResponse(409, "configured_host_unavailable");
    const host = configuredHosts[0]!;
    const sessionError = lifecycleSessionError(record, host, located);
    if (sessionError !== null) return sessionError;
    const operationId = `panel-world-${action}-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
    const stopRequired = record.status === "active" && located.record !== null;
    await machines.worldLifecycle({
      operationId, instanceId: host.providerRef, requestedBy: `identity:${identity.id}`, serverId: located.serverId,
      sessionId: located.record?.activeSessionId ?? "none", worldId, action, backupKey, release,
      stopRequired, targetGenerationId: record.currentGeneration.id,
    });
    return response(202, { result: "requested", operationId });
  }

  return { controlSession, createWorld, updateWorldSettings, updateGameSettings, whitelistOf, readServerWhitelist, updateWhitelist, controlWorldLifecycle };
}

export type WorldsFeature = ReturnType<typeof worldsFeature>;
