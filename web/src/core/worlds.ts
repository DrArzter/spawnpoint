import type { ReleasePackName } from "../api/contract";
import { commitUrl, shortCommit } from "../lib/format";
import type { ControlPlaneSnapshot, Game, Operation, ServerState, Wipe, World, WorldTab } from "../model";
import { routeHash } from "../routing";
import { configuredHosts, fleetPlayersOnline, fleetSessionOf, fleetWorldState, operationsBlockingWorld, playersOnline, sessionReason, sharedSessionOwnerLabel, worldOwnsSharedSession, worldSessionActive, worldState, type SessionReason, type SharedHostSession } from "../session";
import type { PendingMap, SessionAction, WorldActionKind } from "../shell/actions";
import { changedSettings, settingsAvailable } from "./settings";
import { controlPending, pendingFor } from "../shell/actions";
import { action, type Action } from "./actions";
import { promotableReleases, startableLatest, startableReleases } from "./presets";
import { buildStatus, hostStatus, sessionStatus, worldStatus, type StatusDescriptor } from "./status";
import type { AddressFacts, Detail, Notice, SessionOverview, SiblingRow, WorldRow } from "./models";
import { t } from "../i18n";

/*
 * What the Worlds list and the world page know that no skin should have to
 * work out again: which verb a world takes, why it may be refused, what stands
 * in an empty cell, and what each row may do. Pure functions over the snapshot.
 */

export function releaseSummary(world: World): string {
  const { activeRelease, desiredRelease, state } = world.release;
  if (state === "unavailable") return t("world.buildStatusCouldNot");
  if (activeRelease && desiredRelease && activeRelease !== desiredRelease) return t("world.activeActiveReleaseDesiredDesiredRelease", { activeRelease, desiredRelease });
  if (activeRelease) return t("common.releaseActiveRelease", { activeRelease });
  if (desiredRelease) return t("world.readyFirstStart");
  if (world.materialization === "not_created") return world.preset?.buildStatus === "ready" ? t("world.firstStartUsesValue", { value: world.preset.latestRelease ?? t("world.latestRelease") }) : t("world.presetStatus", { status: buildStatus(world.preset?.buildStatus ?? "unbuilt").label.toLowerCase() });
  if (state === "unconfigured") return t("world.noReleaseSelected");
  return t("world.noBuildSelected");
}

export function sessionActionForWorld(world: World, game: Game, sharedSession: SharedHostSession, fleet = false): SessionAction {
  if (fleet) return fleetSessionOf(world)?.activeSessionId ? "stop" : "start";
  return worldOwnsSharedSession(sharedSession, game, world) && sharedSession.state !== "stopped" ? "stop" : "start";
}

export type SessionControl = { action: SessionAction; disabled: boolean; hint: string };

// Why a world cannot be started or stopped at all, whatever the host is doing.
function unavailableReason(world: World): string {
  if (world.materialization === "archived") return t("world.worldArchivedRestoreBackupOpen");
  if (world.materialization === "not_created") return t("world.presetNeedsSuccessfulRelease");
  return t("world.worldNotConnectedSession");
}

// A fleet world is refused for its own session's state, never for another
// world's: each runs on a host launched for it (ADR-0062).
function fleetRefusal(world: World, game: Game): string | null {
  const observed = fleetSessionOf(world)?.observedState;
  if (world.connectivity === "zerotier") return t("world.fleetHostsDoNotJoin");
  if (observed === "starting" || observed === "stopping" || observed === "moving" || observed === "unknown") return t("world.worldObserved", { observed });
  return null;
}

// The shared host is one machine: whoever holds it decides for everyone.
function sharedRefusal(sharedSession: SharedHostSession, action: SessionAction): string | null {
  if (sharedSession.recoveryPending) return t("world.spawnpointReconcilingStoppedHost");
  if (sharedSession.state === "starting" || sharedSession.state === "stopping") return t("world.sharedHostState", { state: sharedSession.state });
  if (sharedSession.state === "unknown") return t("world.spawnpointCannotConfirmShared");
  if (action === "start" && sharedSession.state === "running") {
    const owner = sharedSessionOwnerLabel(sharedSession);
    return owner ? t("world.ownerUsingSharedHost", { owner }) : t("world.anotherSessionUsingShared");
  }
  return null;
}

export function sessionControlAvailability(
  world: World,
  game: Game,
  sharedSession: SharedHostSession,
  permitted: boolean,
  controlBusy: boolean,
  fleet = false,
  /** The running operations that hold this world back; a fleet world waits for its own only. */
  blocking: readonly Operation[] = [],
): SessionControl {
  const action = sessionActionForWorld(world, game, sharedSession, fleet);
  const refuse = (hint: string): SessionControl => ({ action, disabled: true, hint });
  if (!world.sessionControlAvailable) return refuse(unavailableReason(world));
  if (!permitted) return refuse(action === "start" ? t("world.roleCannotStartSessions") : t("world.roleCannotStopSessions"));
  if (controlBusy || (fleet ? blocking.length > 0 : sharedSession.operationRunning)) return refuse(t("world.controlPlaneOperationAlreadyProgress"));
  const refusal = fleet ? fleetRefusal(world, game) : sharedRefusal(sharedSession, action);
  if (refusal !== null) return refuse(refusal);
  if (fleet) return { action, disabled: false, hint: action === "start" ? t("world.launchReuseBilledFleet") : t("world.saveBackUpSession") };
  return { action, disabled: false, hint: action === "start" ? t("world.startBilledSessionShared") : t("world.saveBackUpStopSession") };
}

// A request in flight holds its own world, and a configured world also holds
// its game's other configured worlds, which share one host. A fleet world is
// never held by another's (ADR-0062).
function heldByPending(game: Game, world: World, pending: PendingMap): boolean {
  if (world.placement === "fleet") return controlPending(pending, [world]);
  return controlPending(pending, game.worlds.filter((item) => item.placement !== "fleet"));
}

/** Start or stop for one world, and why it may be refused, from the console's state. */
export function worldSessionControl(game: Game, world: World, inputs: Readonly<{ snapshot: ControlPlaneSnapshot | null; sharedSession: SharedHostSession; granted: ReadonlySet<string>; pending: PendingMap; busy: boolean }>): SessionControl {
  const fleet = world.placement === "fleet";
  const verb = sessionActionForWorld(world, game, inputs.sharedSession, fleet);
  const permitted = inputs.granted.has(verb === "start" ? "session.start" : "session.stop");
  const controlBusy = heldByPending(game, world, inputs.pending) || inputs.busy;
  return sessionControlAvailability(world, game, inputs.sharedSession, permitted, controlBusy, fleet, operationsBlockingWorld(inputs.snapshot, world));
}

export function addressFacts(world: World): AddressFacts | null {
  if (!world.connectionAddress) return null;
  const zerotier = world.connectivity === "zerotier";
  return {
    value: world.connectionAddress,
    connectivity: world.connectivity,
    network: zerotier ? t("world.zeroTierNetworkReachableOnly") : t("world.publicAddressReachableFrom"),
  };
}

export function missingAddressLabel(world: World, serverState: ServerState): string {
  if (world.materialization !== "existing") return t("world.noAddress");
  return serverState === "running" ? t("world.noAddressYet") : t("world.assignedWhileOnline");
}

function fleetWorlds(game: Game | undefined, state: ServerState): World[] {
  return game?.worlds.filter((world) => world.placement === "fleet" && fleetWorldState(game, world) === state) ?? [];
}

function fleetReason(game: Game | undefined): string {
  const running = fleetWorlds(game, "running");
  if (fleetWorlds(game, "unknown").length > 0) return t("world.spawnpointCannotConfirmState");
  if (fleetWorlds(game, "moving").length > 0) return t("world.worldMovingHostReclaimed");
  if (fleetWorlds(game, "starting").length > 0) return t("world.fleetHostBeingAssigned");
  if (fleetWorlds(game, "stopping").length > 0) return t("world.worldSavingHostDraining");
  if (running.length > 1) return t("world.runningCountWorldsRunningEach", { runningCount: running.length });
  if (running.length === 1) return t("world.displayNameRunningFleetHost", { displayName: running[0]!.displayName });
  return t("world.noSessionGameFleet");
}

function sumKnown(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

// What the session panel names: the one world running, with its game when it
// is another's; how many run, when several do; else the game.
function sessionSubject(game: Game | undefined, activeGame: Game | undefined, activeWorld: World | null, runningCount: number): string {
  if (activeWorld) return activeGame && activeGame.id !== game?.id ? `${activeWorld.displayName} (${activeGame.displayName})` : activeWorld.displayName;
  if (runningCount > 1) return t("world.runningCountWorlds", { runningCount });
  return game?.displayName ?? t("world.session");
}

export function buildSessionOverview(game: Game | undefined, snapshot: ControlPlaneSnapshot | null, serverState: ServerState, sharedSession: SharedHostSession, fleet: boolean): SessionOverview {
  const host = configuredHosts(snapshot)[0];
  const status = sessionStatus(serverState);
  const reason = sessionReason(sharedSession, game);
  const hosts = snapshot?.hosts ?? [];
  const activeGame = fleet ? game : sharedSession.activeGame ?? game;
  const running = fleet ? fleetWorlds(game, "running") : [];
  const soleRunning = running.length === 1 ? running[0]! : null;
  const activeWorld = fleet ? soleRunning : sharedSession.activeWorld;
  const subject = sessionSubject(game, activeGame, activeWorld, running.length);
  return {
    fleet,
    state: serverState,
    status,
    headline: `${subject} ${status.label.toLowerCase()}`,
    reason: fleet ? { text: fleetReason(game), detail: reason.detail, attention: false } : reason,
    players: fleet && game ? sumKnown(running.map((world) => fleetPlayersOnline(game, world))) : playersOnline(activeGame),
    observedAt: snapshot?.observedAt,
    host: host ? { name: host.name, status: hostStatus(host.state), instanceType: host.instanceType ?? null, zone: host.availabilityZone ?? null, launchedAt: host.launchedAt ?? null } : null,
    fleetHosts: {
      running: hosts.filter((item) => item.provenance === "launched" && item.state === "running").length,
      pending: hosts.filter((item) => item.provenance === "launched" && item.state === "pending").length,
      // ADR-0102: hosts EC2 may reclaim. A viewer without infrastructure detail sees no market.
      spot: hosts.filter((item) => item.provenance === "launched" && item.state === "running" && item.market === "spot").length,
    },
  };
}

export type WorldCallbacks = Readonly<{
  onWorldAction: (game: Game, world: World, action: WorldActionKind, backup?: { key: string; name: string; release: string | null }) => void;
  onInvite: (game: Game, world: World) => void;
  onDownloadPack: (game: Game, world: World) => void;
  onEditSettings?: (game: Game, world: World) => void;
  /** Present when the deployment can keep game settings (ADR-0064). */
  onEditGameSettings?: (game: Game, world: World) => void;
  /** Present when the deployment promotes fleet worlds (ADR-0078). */
  onPromote?: (game: Game, world: World) => void;
}>;

export function presetOf(game: Game, world: World) {
  return game.presets.find((item) => item.id === (world.preset?.id ?? world.profileId));
}

/** The row's own verbs, in the order a menu lists them. Start and stop are not here: they spend money, and the world page can say why they are refused. */
export function rowActions(game: Game, world: World, granted: ReadonlySet<string>, busy: boolean, callbacks: WorldCallbacks): Action[] {
  const items: Action[] = [
    action("world.details", t("world.viewDetails"), () => { window.location.hash = routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: world.id }); }, { icon: "chevron_right" }),
  ];
  if (granted.has("invitation.send")) items.push(action("world.invite", t("common.invitePlayers"), () => callbacks.onInvite(game, world), { icon: "send" }));
  if (granted.has("connection.read")) items.push(packAction(game, world, busy, callbacks));
  items.push(...promoteActions(game, world, granted, busy, callbacks));
  if (!granted.has("world.manage")) return items;
  items.push(...lifecycleActions(game, world, busy, callbacks));
  return items;
}

/** The wipe has a pointer and has run nothing: it holds no save, so its release may still change (ADR-0078). Archives are not loaded here; the API refuses a wipe that has one. */
export function neverStarted(world: World): boolean {
  const { release } = world;
  return release.state === "available" && release.generationId !== null && release.activeRelease === null && (release.runCount ?? 0) === 0;
}

/** The releases a world's wipe may move to: its preset's others, newest first. */
export function promotionTargets(game: Game, world: World): readonly string[] {
  const preset = presetOf(game, world);
  if (!preset) return [];
  // A wipe that never started takes any release a new world may use; there is no save to protect.
  if (neverStarted(world)) return [...startableReleases(preset)].reverse().filter((release) => release !== world.release.desiredRelease);
  // Only releases after the active one: going back is a restore (ADR-0052).
  const at = world.release.activeRelease === null ? -1 : preset.releases.indexOf(world.release.activeRelease);
  const usable = promotableReleases(preset);
  return preset.releases.slice(at + 1).filter((release) => usable.includes(release)).reverse();
}

function promotionReason(game: Game, world: World): string | undefined {
  if (!world.release.activeRelease && !neverStarted(world)) return t("world.availableOnceReleaseActive");
  if (neverStarted(world)) {
    if (worldSessionActive(game, world)) return t("world.refusedWhileSessionRuns");
    return promotionTargets(game, world).length === 0 ? t("world.noOtherBuiltRelease") : undefined;
  }
  if (promotionTargets(game, world).length === 0) return t("world.noNewerBuiltRelease");
  return (fleetPlayersOnline(game, world) ?? 0) > 0 ? t("world.refusedWhilePlayersOnline") : undefined;
}

// Keeping the save across a release change is release.promote, the Owner's (ADR-0078).
function promoteActions(game: Game, world: World, granted: ReadonlySet<string>, busy: boolean, callbacks: WorldCallbacks): Action[] {
  const promote = callbacks.onPromote;
  if (!promote || !granted.has("release.promote") || world.placement !== "fleet" || world.materialization !== "existing") return [];
  const reason = promotionReason(game, world);
  return [action("world.promote", t("world.updateRelease"), () => promote(game, world), {
    icon: "deployed_code", disabled: busy || reason !== undefined,
    detail: reason ?? (neverStarted(world) ? t("world.switchesReleaseBeforeFirstStart") : t("world.keepsSaveTakesBackup")),
  })];
}

function packAction(game: Game, world: World, busy: boolean, callbacks: WorldCallbacks): Action {
  return action("world.pack", t("world.downloadClientPack"), () => callbacks.onDownloadPack(game, world), {
    icon: "download",
    disabled: !world.release.activeRelease || busy,
    hint: world.release.activeRelease ? t("world.packReleaseActiveRelease", { activeRelease: world.release.activeRelease }) : t("world.availableOnceReleaseActive"),
  });
}

function lifecycleActions(game: Game, world: World, busy: boolean, callbacks: WorldCallbacks): Action[] {
  const preset = presetOf(game, world);
  if (world.materialization === "existing") {
    return [
      action("world.wipe", t("world.startNewWipe2"), () => callbacks.onWorldAction(game, world, "wipe"), { icon: "history", disabled: busy || !preset || startableLatest(preset) === null, detail: preset && startableLatest(preset) ? t("world.fromPresetDisplayNameStartableLatest", { presetDisplayName: preset.displayName, startableLatest: startableLatest(preset) ?? "" }) : t("world.needsBuiltRelease") }),
      action("world.archive", t("world.archive"), () => callbacks.onWorldAction(game, world, "archive"), { icon: "archive", disabled: busy, detail: t("world.stopsBacksUpHides") }),
    ];
  }
  if (world.materialization === "archived") {
    return [action("world.purge", t("world.deletePermanently"), () => callbacks.onWorldAction(game, world, "purge"), { icon: "delete_forever", danger: true, disabled: busy, detail: t("world.registryPointerEveryBackup") })];
  }
  return [];
}

/** The world page's overflow: what the list has, plus hosting, minus details and invite (which the page shows on its own). */
export function worldMoreActions(game: Game, world: World, granted: ReadonlySet<string>, busy: boolean, callbacks: WorldCallbacks): Action[] {
  const items: Action[] = [];
  if (granted.has("connection.read")) items.push(packAction(game, world, busy, callbacks));
  items.push(...promoteActions(game, world, granted, busy, callbacks));
  if (!granted.has("world.manage")) return items;
  if (world.materialization !== "archived" && callbacks.onEditSettings) {
    const edit = callbacks.onEditSettings;
    items.push(action("world.settings", t("world.hostingConnection"), () => edit(game, world), { icon: "dns", disabled: busy }));
  }
  if (world.materialization !== "archived" && callbacks.onEditGameSettings && settingsAvailable(game)) {
    const edit = callbacks.onEditGameSettings;
    items.push(action("world.game-settings", t("world.gameSettings"), () => edit(game, world), { icon: "tune", disabled: busy }));
  }
  items.push(...lifecycleActions(game, world, busy, callbacks));
  return items;
}

// Whether a world's row shows it running: a fleet world by its own session, a
// configured one by its game's record or by the shared host it holds.
function worldRunning(game: Game, world: World, opts: Readonly<{ fleet: boolean; sharedSession: SharedHostSession }>, state: ServerState | null): boolean {
  if (world.placement === "fleet") return state === "running";
  if (opts.fleet) return game.lifecycle?.activeWorldId === world.id && game.lifecycle.observedState === "ready";
  return worldOwnsSharedSession(opts.sharedSession, game, world) && opts.sharedSession.state === "running";
}

function rowStatus(world: World, active: boolean, state: ServerState | null): StatusDescriptor {
  if (active) return sessionStatus("running");
  if (state === "starting" || state === "stopping" || state === "moving") return sessionStatus(state);
  return worldStatus(world);
}

/**
 * A stop asked while players are online disconnects them, for a caller who may.
 * Anyone else gets the plain stop, which the host refuses while they play.
 */
export function stopDisconnect(game: Game, world: World, action: "start" | "stop", granted: ReadonlySet<string>, sharedSession: SharedHostSession): { disconnect?: number } {
  if (action !== "stop" || !granted.has("session.stop.force")) return {};
  const players = worldPlayers(game, world, sharedSession) ?? 0;
  return players > 0 ? { disconnect: players } : {};
}

/** Players on a world's own session: a fleet world's from its record, a configured one's only while it holds the shared host. */
export function worldPlayers(game: Game, world: World, sharedSession: SharedHostSession): number | null {
  if (world.placement === "fleet") return fleetPlayersOnline(game, world);
  return worldOwnsSharedSession(sharedSession, game, world) ? playersOnline(game) : null;
}

// When the world's own session became ready: the start of its uptime. A session
// record from before the field existed has none, and a fleet world then has no
// other clock, as the snapshot names no fleet world's host. A configured world
// falls back to the shared host's launch.
export function worldLaunchedAt(game: Game, world: World, sharedSession: SharedHostSession, snapshot: ControlPlaneSnapshot | null): string | null {
  const own = world.placement === "fleet" ? fleetSessionOf(world) : game.lifecycle;
  const readyAt = own?.activeWorldId === world.id && own.observedState === "ready" ? own.readyAtEpochSeconds : null;
  if (readyAt != null) return new Date(readyAt * 1000).toISOString();
  if (world.placement === "fleet" || !worldOwnsSharedSession(sharedSession, game, world) || sharedSession.state === "stopped") return null;
  return configuredHosts(snapshot)[0]?.launchedAt ?? null;
}

export function buildWorldRow(game: Game, world: World, opts: Readonly<{ fleet: boolean; sharedSession: SharedHostSession; granted: ReadonlySet<string>; pending: PendingMap; callbacks: WorldCallbacks; snapshot?: ControlPlaneSnapshot | null }>): WorldRow {
  // A fleet world's row tells its own session's state, so two of one game read apart.
  const fleetWorld = world.placement === "fleet";
  const state = fleetWorld ? fleetWorldState(game, world) : null;
  const active = worldRunning(game, world, opts, state);
  const wipe = world.wipes.find((item) => item.state === "current") ?? world.wipes.at(-1);
  return {
    world,
    href: routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: world.id }),
    status: rowStatus(world, active, state),
    presetName: presetOf(game, world)?.displayName ?? world.profileId,
    releaseSummary: releaseSummary(world),
    wipe: wipe ? { number: wipe.number } : null,
    wipeAbsent: t("world.noWipesYet"),
    address: addressFacts(world),
    addressAbsent: missingAddressLabel(world, worldState(game, world, opts.sharedSession)),
    actions: rowActions(game, world, opts.granted, pendingFor(opts.pending, world.id) !== null, opts.callbacks),
    players: worldPlayers(game, world, opts.sharedSession),
    launchedAt: worldLaunchedAt(game, world, opts.sharedSession, opts.snapshot ?? null),
  };
}

/** A row as data only, for a list beside another world's page. */
export function siblingRow(row: WorldRow): SiblingRow {
  return {
    id: row.world.id,
    name: row.world.displayName,
    href: row.href,
    status: row.status,
    releaseSummary: row.releaseSummary,
    wipe: row.wipe?.number ?? null,
    players: row.players ?? null,
    placement: row.world.placement === "fleet" ? "fleet" : "configured",
    address: row.address,
  };
}

export function worldTabs(world: World, offered: Readonly<{ releases: boolean; whitelist: boolean; config: boolean; console: boolean; log: boolean; metrics: boolean }>): { id: WorldTab; label: string; count?: number }[] {
  const tabs: { id: WorldTab; label: string; count?: number }[] = [
    { id: "details", label: t("world.details") },
    { id: "wipes", label: t("world.wipes"), count: world.wipes.length },
    { id: "backups", label: t("common.backups") },
  ];
  if (offered.releases) tabs.push({ id: "releases", label: t("common.releases") });
  if (offered.whitelist) tabs.push({ id: "whitelist", label: t("common.whitelist") });
  if (offered.config) tabs.push({ id: "config", label: t("world.config") });
  // A world's own console and its own host's metrics (ADR-0062, ADR-0063).
  if (offered.console) tabs.push({ id: "console", label: t("world.console") });
  if (offered.log) tabs.push({ id: "log", label: t("common.log") });
  if (offered.metrics) tabs.push({ id: "metrics", label: t("common.metrics") });
  return tabs;
}

type Host = ControlPlaneSnapshot["hosts"][number];

function sessionHint(fleet: boolean, game: Game, world: World, reason: SessionReason): string {
  if (!fleet) return reason.text;
  return fleetSessionOf(world)?.activeSessionId ? t("world.worldRunsOwnSession") : t("world.worldHasNoActive");
}

function hostDetail(host: Host | undefined): Detail {
  if (!host) return { key: "host", label: t("common.computeHost"), value: { type: "absent", text: t("world.noHostAvailable") } };
  // The state is the value; which host, and what kind, is the line under it.
  const zone = host.availabilityZone ? t("world.availabilityZone", { availabilityZone: host.availabilityZone }) : "";
  return {
    key: "host",
    label: t("common.computeHost"),
    value: { type: "status", status: hostStatus(host.state) },
    hint: [host.name, host.instanceType ? `${host.instanceType}${zone}` : null].filter(Boolean).join(" · "),
  };
}

function launchedDetail(host: Host): Detail {
  return { key: "launched", label: t("world.launched"), value: host.launchedAt ? { type: "time", at: host.launchedAt } : { type: "absent", text: t("world.notRunning") } };
}

export function sessionDetails(game: Game, world: World, sharedSession: SharedHostSession, snapshot: ControlPlaneSnapshot | null, serverState: ServerState, fleet: boolean): Detail[] {
  const host = configuredHosts(snapshot)[0];
  const reason = sessionReason(sharedSession, game, world);
  const players = worldPlayers(game, world, sharedSession);
  const details: Detail[] = [{
    key: "session",
    label: t("world.session"),
    value: { type: "status", status: sessionStatus(serverState) },
    explain: sessionHint(fleet, game, world, reason),
  }];
  // A fleet world's host is its own; the fleet-wide count belongs to the Worlds overview.
  if (!fleet) {
    details.push(hostDetail(host));
    if (host) details.push(launchedDetail(host));
  }
  if (players !== null) details.push({ key: "players", label: t("world.playersOnline"), value: { type: "number", value: players } });
  details.push({ key: "observed", label: t("world.lastObserved"), value: { type: "time", at: snapshot?.observedAt } });
  return details;
}

export function worldDetails(game: Game, world: World, serverState: ServerState): Detail[] {
  const preset = presetOf(game, world);
  const currentWipe = world.wipes.find((wipe) => wipe.state === "current") ?? world.wipes.at(-1);
  const hasRelease = Boolean(world.release.activeRelease || world.release.desiredRelease);
  const availability = worldStatus(world);
  const address = addressFacts(world);
  return [
    { key: "world-id", label: t("world.worldID"), value: { type: "text", text: world.id, mono: true } },
    { key: "availability", label: t("world.availability"), value: { type: "status", status: availability } },
    {
      key: "preset",
      label: t("common.preset"),
      value: {
        type: "preset",
        name: preset?.displayName ?? world.profileId,
        source: world.preset ? { commit: world.preset.commit, short: shortCommit(world.preset.commit), href: commitUrl(world.preset.repository, world.preset.commit) } : null,
      },
      explain: world.preset ? undefined : t("world.notBuiltFromGit"),
    },
    { key: "release", label: t("common.release"), value: hasRelease ? { type: "release", active: world.release.activeRelease, desired: world.release.desiredRelease } : { type: "absent", text: releaseSummary(world) } },
    { key: "wipe", label: t("world.currentWipe"), value: currentWipe ? { type: "text", text: `#${currentWipe.number}` } : { type: "absent", text: t("world.noWipesYet") } },
    { key: "address", label: t("common.address"), value: address ? { type: "address", address } : { type: "absent", text: missingAddressLabel(world, serverState) }, copy: world.connectionAddress ?? undefined },
    { key: "hosting", label: t("world.hosting"), value: { type: "text", text: world.placement === "fleet" ? t("world.onDemandFleet") : t("world.persistentHost") } },
    { key: "connection", label: t("world.connection"), value: { type: "text", text: connectionLabels[world.connectivity] } },
    ...gameSettingsDetail(game, world),
  ];
}

// The game settings this world changed from its game's defaults (ADR-0064).
function gameSettingsDetail(game: Game, world: World): Detail[] {
  if (!settingsAvailable(game)) return [];
  const changed = changedSettings(game, world);
  return [{
    key: "game-settings",
    label: t("world.gameSettings"),
    value: changed.length > 0 ? { type: "text", text: changed.join(", ") } : { type: "absent", text: t("world.gameDefaults") },
    ...(world.gameSettings.updatedAt ? { hint: t("common.changed"), hintTime: world.gameSettings.updatedAt } : {}),
  }];
}

const connectionLabels: Record<World["connectivity"], string> = { zerotier: "ZeroTier", route53: t("world.publicDNS"), raw: t("world.publicIP") };

/** How a world is reached, in the one word every screen uses. */
export function connectionLabel(connectivity: World["connectivity"]): string {
  return connectionLabels[connectivity];
}

const operationLabels: Record<Operation["type"], string> = { start: t("world.startingSession"), stop: t("world.stoppingSession"), world: t("world.updatingWorld"), promote: t("world.promotingRelease"), host: t("world.deletingHost") };

export function operationLabel(type: Operation["type"]): string {
  return operationLabels[type];
}

export function worldNotices(world: World): Notice[] {
  const notices: Notice[] = [];
  // A request in flight shows on its busy verb and in Operations, not as a notice.
  if (world.materialization === "archived") notices.push({ id: "archived", tone: "warning", title: t("world.worldArchived") });
  return notices;
}

export function releaseRows(world: World, canDownload: boolean, busy: boolean, download: () => void): Array<{ name: string; status: string; downloadable: boolean; sourceHref: string | null; sourceRepository: string | null; sourceCommit: string | null; downloads: readonly Action[] }> {
  const map = new Map<string, { name: string; status: string; downloadable: boolean }>();
  if (world.release.activeRelease) map.set(world.release.activeRelease, { name: world.release.activeRelease, status: t("common.active"), downloadable: true });
  if (world.release.desiredRelease) {
    map.set(world.release.desiredRelease, {
      name: world.release.desiredRelease,
      status: world.release.desiredRelease === world.release.activeRelease ? t("world.activeDesired") : t("common.desired"),
      downloadable: world.release.desiredRelease === world.release.activeRelease,
    });
  }
  return [...map.values()].map((row) => ({
    ...row,
    sourceHref: world.preset ? commitUrl(world.preset.repository, world.preset.commit) : null,
    sourceRepository: world.preset?.repository ?? null,
    sourceCommit: world.preset?.commit ?? null,
    downloads: row.downloadable && canDownload ? [action("world.pack", t("common.download"), download, { icon: "download", disabled: busy, hint: t("world.clientPackRelease") })] : [],
  }));
}

/**
 * A release with side lists (ADR-0069) offers three packs where it offered one:
 * the client pack players install, the server's set, and every mod together.
 * `splitRelease` names the release whose manifest says so, once it is read.
 */
export function withReleasePacks<Row extends Readonly<{ name: string; downloads: readonly Action[] }>>(rows: readonly Row[], splitRelease: string | null, download: (release: string, pack: ReleasePackName) => void): Row[] {
  return rows.map((row) => row.name !== splitRelease ? row : {
    ...row,
    downloads: [
      ...row.downloads.map((client) => ({ ...client, label: t("world.client"), hint: t("world.whatPlayersInstall") })),
      action("release.pack.server", t("common.server"), () => download(row.name, "server"), { icon: "download", hint: t("world.everyModServerRuns") }),
      action("release.pack.full", t("world.full"), () => download(row.name, "full"), { icon: "download", hint: t("world.everyModServerPlayers") }),
    ],
  });
}

export function wipeStatus(wipe: Wipe): StatusDescriptor {
  return wipe.state === "current" ? { kind: "ok", label: t("world.current") } : { kind: "off", label: t("world.closed") };
}
