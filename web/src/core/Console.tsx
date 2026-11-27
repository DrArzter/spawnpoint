import { useEffect, useState } from "react";

import type { ApiFailureKind, ConsoleEntry } from "../api/contract";
import type { ActiveSession } from "../api/contract";
import { useSnackbar } from "../components/ui/Snackbar";
import type { Game, Preset, World, WorldTab } from "../model";
import { routeHash, type WorldsView } from "../routing";
import { operationsBlockingWorld, runningWorlds, worldSessionId, worldState } from "../session";
import { pendingFor, pendingOf } from "../shell/actions";
import type { Skin } from "../skins/skin";
import { action, type Action } from "./actions";
import { failureView } from "./failure";
import { releaseBuildCopy } from "./release-builds";
import { startableReleases } from "./presets";
import { presetBuildStates, sessionStatus, worldStatus, type StatusDescriptor } from "./status";
import { AVATAR_ACCEPT } from "./avatar-image";
import { chooseFile } from "./choose-file";
import { useConsole, type ConsoleController } from "./useConsole";
import { accessRequests, useBackups, useConsoleGateway, type ConsoleGateway, useInvitation, useLoginAccounts, useNotifications, useConfigFiles, useWorldLog, useReleaseChanges, useReleaseMods, useRoles, useUsers, useWhitelist, useWorldMetrics } from "./data";
import { newestRunning, progressModel, useOperationProgress } from "./operation-progress";
import { persistentHostNotice } from "./hosts";
import { useConfirmationForm, useCreateWorldForm, useGameSettingsForm, useWorldSettingsForm } from "./forms";
import type { AccessModel, ConsoleLine, ConsoleModel, LookModel, Notice, OperationRow, ReleasesModel, ShellModel, WorldModel, WorldRow, WorldsModel } from "./models";
import { addressFacts, buildSessionOverview, buildWorldRow, operationLabel, releaseRows, releaseSummary, sessionDetails, siblingRow, withReleasePacks, worldDetails, worldLaunchedAt, worldMoreActions, worldNotices, worldPlayers, worldSessionControl, worldTabs } from "./worlds";
import { currentLocale, LOCALE_NAMES, LOCALES, speak, t } from "../i18n";

/*
 * The controllers: each takes the console's bones, builds one page's model
 * and hands it to the skin's view. A page's own data loads only while that
 * page is shown, which is why these are components and not one hook.
 */

export type LookChoices = Readonly<{ current: string; options: readonly Readonly<{ id: string; name: string }>[]; wear: (id: string) => void }>;

export function ConsoleRoot({ session, skin, looks, continuesBootCard }: Readonly<{ session: ActiveSession; skin: Skin; looks: LookChoices; continuesBootCard: boolean }>) {
  const notify = useSnackbar();
  const console = useConsole(session, continuesBootCard, notify);
  if (!console.booted) return console.bootVisible ? <skin.Boot model={{ title: t("app.preparingConsole") }} /> : null;
  return (
    <skin.Shell model={shellModel(console)}>
      <CurrentPage console={console} looks={looks} skin={skin} />
      <skin.ScopeDialog model={console.shell.scope} />
      <ConfirmationController console={console} skin={skin} />
      {console.invite && <InvitationController console={console} game={console.invite.game} skin={skin} world={console.invite.world} />}
      {console.creating && <CreateWorldController console={console} game={console.creating.game} preset={console.creating.preset} skin={skin} />}
      {console.editing && <WorldSettingsController console={console} game={console.editing.game} skin={skin} world={console.editing.world} />}
      {console.editingGameSettings && <GameSettingsController console={console} game={console.editingGameSettings.game} skin={skin} world={console.editingGameSettings.world} />}
    </skin.Shell>
  );
}

type Controlled = Readonly<{ console: ConsoleController; skin: Skin }>;

function CurrentPage({ console, skin, looks }: Controlled & Readonly<{ looks: LookChoices }>) {
  const { page, game, world } = console;
  if (page === "worlds" && game && world) return <WorldPage console={console} game={game} skin={skin} world={world} />;
  if (page === "worlds") return <WorldsPage console={console} skin={skin} />;
  if (page === "releases") return <skin.Releases model={releasesModel(console)} />;
  if (page === "access") return <AccessPage console={console} skin={skin} />;
  return <ProfilePage console={console} looks={looks} skin={skin} />;
}

function refreshAction(console: ConsoleController): Action {
  return action("refresh", t("common.refresh"), () => void console.refresh(), { icon: "refresh", busy: console.refreshing });
}

// The scoped game's worlds as rows, each with the verb its own page offers.
function worldRows(console: ConsoleController): WorldRow[] {
  const { game, snapshot, granted, pending, sharedSession, fleetOverview, worldCallbacks } = console;
  if (!game) return [];
  return game.worlds.map((world) => {
    const row = buildWorldRow(game, world, { fleet: fleetOverview, sharedSession, granted, pending, callbacks: worldCallbacks, snapshot });
    return { ...row, sessionAction: () => worldSessionVerb(console, game, world) };
  });
}

function worldSessionVerb(console: ConsoleController, game: Game, world: World): Action {
  const rowPending = pendingFor(console.pending, world.id);
  return sessionVerb(console, game, world, rowPending !== null, rowPending?.kind === "session");
}

// The frame's model, with what it asks for about the scoped game's worlds.
function shellModel(console: ConsoleController): ShellModel {
  const { game, granted, worldCallbacks } = console;
  const rows = worldRows(console);
  return {
    ...console.shell,
    worlds: rows.map((row) => ({ id: row.world.id, name: row.world.displayName, href: row.href, status: row.status })),
    refreshAction: () => refreshAction(console),
    flash: { operations: gameOperationRows(game, console.snapshot).map((row) => ({ id: row.operation.id, label: row.label, worldName: row.worldName, worldId: row.operation.worldId ?? "", startedAt: row.operation.startedAt, expectedSeconds: row.operation.expectedSeconds, expectedSamples: row.operation.expectedSamples })) },
    worldActions: (worldId) => {
      const world = game?.worlds.find((item) => item.id === worldId);
      if (!game || !world) return null;
      return {
        session: worldSessionVerb(console, game, world),
        invite: granted.has("invitation.send") ? action("world.invite", t("common.invitePlayers"), () => worldCallbacks.onInvite(game, world), { icon: "send" }) : null,
      };
    },
  };
}

// The game's running operations, each named by the world it holds.
function gameOperationRows(game: Game | undefined, snapshot: ConsoleController["snapshot"]): OperationRow[] {
  if (!game) return [];
  return (snapshot?.operations ?? []).flatMap((operation) => {
    const world = game.worlds.find((item) => item.id === operation.worldId);
    return world ? [{ operation, label: operationLabel(operation.type), worldName: world.displayName, href: routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: world.id }) }] : [];
  });
}

function gamesFailure(listStatus: "loading" | "ready" | "error", kind: ApiFailureKind) {
  if (listStatus !== "error") return { title: t("common.noGamesYet"), description: t("app.noGamesYetDeclare"), retry: false };
  const view = failureView(kind, t("app.gamesCouldNotLoaded"), t("app.viewGames"), t("app.spawnpointCouldNotRead"));
  return { title: view.title, description: view.message ?? "", retry: view.retry };
}

function stateNotice(kind: ApiFailureKind, error: string, retry: () => void): Notice {
  const view = failureView(kind, t("app.currentStateCouldNot"), t("app.viewServerStatus"), error);
  return { id: "load", tone: view.kind === "forbidden" ? "warning" : "error", title: view.title, ...(view.message === null ? {} : { description: view.message }), ...(view.retry ? { action: action("refresh", t("common.tryAgain"), retry) } : {}) };
}

function WorldsPage({ console, skin }: Controlled) {
  const { game, snapshot, listStatus, error, errorKind, granted, sharedSession, serverState, fleetOverview, route, directory } = console;
  const loading = listStatus === "loading";
  const canManage = granted.has("world.manage");
  const readyPreset = game?.presets.some((preset) => startableReleases(preset).length > 0) ?? false;
  const view = route.worldsView;
  const requests = accessRequests(directory);
  const { refresh: refreshAccess } = directory;
  const showRequests = view === "overview" && granted.has("access.manage");
  useEffect(() => { if (showRequests) refreshAccess(); }, [showRequests, refreshAccess]);
  const viewHref = (worldsView: WorldsView) => routeHash({ page: "worlds", accessTab: "users", gameId: game?.id ?? null, worldId: null, worldsView });
  const model: WorldsModel = {
    status: listStatus,
    error,
    errorKind,
    game,
    unavailable: !loading && !game ? { failed: listStatus === "error", ...gamesFailure(listStatus, errorKind) } : null,
    notices: listStatus === "error"
      ? [stateNotice(errorKind, error, () => void console.refresh())]
      : [persistentHostNotice(snapshot, granted.has("host.manage") && console.capabilities.has("hostDeletion"), console.requestHostDeletion)].filter((notice) => notice !== null),
    overview: buildSessionOverview(game, snapshot, serverState, sharedSession, fleetOverview),
    rows: worldRows(console),
    emptyDescription: canManage && readyPreset ? null : t("app.worldsAppearHereOnce"),
    refresh: refreshAction(console),
    createWorld: canManage && readyPreset && game ? action("world.create", t("common.createWorld"), () => console.requestCreateWorld(game), { icon: "add" }) : null,
    view,
    views: { overview: viewHref("overview"), list: viewHref("list") },
    operations: gameOperationRows(game, snapshot),
    builds: (game?.presets ?? []).map((preset) => ({ preset, ...presetBuildStates(preset) })),
    requests: showRequests ? requests.requests : null,
    requestActions: requests.actions,
  };
  return <skin.Worlds model={model} />;
}

// Start or stop, and why it may be refused: a fleet world answers for its own
// session, a configured one for the shared host (ADR-0062).
function sessionVerb(console: ConsoleController, game: Game, world: World, busy: boolean, sessionBusy: boolean): Action {
  const { snapshot, granted, pending, sharedSession } = console;
  const control = worldSessionControl(game, world, { snapshot, sharedSession, granted, pending, busy });
  const verb = control.action;
  const stop = verb === "stop";
  return action(`session.${verb}`, stop ? t("common.stop") : t("common.start"), () => console.requestSession(game, world, verb), {
    icon: stop ? "stop" : "play_arrow",
    danger: stop,
    disabled: control.disabled,
    busy: sessionBusy,
    hint: control.hint,
  });
}

// The release a world starts with, whose server mods the Releases tab lists (ADR-0065).
function modsSource(world: World, open: boolean): Readonly<{ presetId: string; version: string }> | null {
  const version = world.release.desiredRelease ?? world.release.activeRelease;
  return open && world.preset !== null && version !== null ? { presetId: world.preset.id, version } : null;
}

// The same release's changes (P3): against the active release while a
// promotion waits, otherwise against what its build compared it with.
function changesSource(world: World, open: boolean): Readonly<{ presetId: string; version: string; from: string | null }> | null {
  const source = modsSource(world, open);
  if (source === null) return null;
  const { activeRelease } = world.release;
  return { ...source, from: activeRelease !== null && activeRelease !== source.version ? activeRelease : null };
}

// A whitelist kept on the world's record (ADR-0066): a game that keeps one, a
// live world, a role and a deployment that manage it.
function whitelistOffered(console: ConsoleController, game: Game, world: World): boolean {
  return console.granted.has("whitelist.manage") && console.capabilities.has("whitelist") && game.whitelist === true &&
    world.materialization !== "archived";
}

// A world's own config files (ADR-0093): a role that edits them, a deployment
// that serves them and a live world. A game with no config rules
// lists no files.
function configOffered(console: ConsoleController, world: World): boolean {
  return console.granted.has("config.edit") && console.capabilities.has("configFiles") && world.materialization !== "archived";
}

// The world page's tabs, and what each reads, only while it is open: a closed
// tab costs no host a request.
function useWorldTabs(console: ConsoleController, game: Game, world: World, notify: ReturnType<typeof useSnackbar>) {
  const { granted, capabilities, route } = console;
  const tabs = worldTabs(world, {
    releases: granted.has("release.read"),
    whitelist: whitelistOffered(console, game, world),
    config: configOffered(console, world),
    console: granted.has("console.use") && capabilities.has("consoleGateway"),
    log: granted.has("log.read") && capabilities.has("worldLog"),
    metrics: granted.has("metrics.read") && capabilities.has("worldMetrics"),
  });
  const offered = (tab: WorldTab) => tabs.some((item) => item.id === tab);
  const open = (tab: WorldTab) => route.worldTab === tab && offered(tab);
  const running = runningWorlds(game).some((item) => item.id === world.id);
  const consoleModel = useWorldConsole(game, world, open("console"), running, notify);
  const metrics = useWorldMetrics(open("metrics") ? game.id : undefined, world.id, worldSessionId(game, world));
  const whitelist = useWhitelist(game.id, world, open("whitelist"), notify, game.playerName);
  const config = useConfigFiles(game.id, world, open("config"), notify);
  // The assistant is an Owner's: assistant.use is reserved to the Owner role (ADR-0094).
  const log = useWorldLog(game.id, world, running, granted.has("assistant.use") && capabilities.has("assistant"), notify);
  const mods = useReleaseMods(game.id, modsSource(world, open("releases") && capabilities.has("releaseFiles")), (presetId, version, mod) => console.downloadMod(game, presetId, version, mod));
  const changes = useReleaseChanges(game.id, changesSource(world, open("releases") && capabilities.has("releaseDiff")));
  return {
    tabs,
    mods,
    changes,
    whitelist: offered("whitelist") ? whitelist : null,
    config: offered("config") ? config : null,
    console: offered("console") ? consoleModel : null,
    log: offered("log") ? log : null,
    metrics: offered("metrics") ? metrics : null,
  };
}

function WorldPage({ console, skin, game, world }: Controlled & Readonly<{ game: Game; world: World }>) {
  const { snapshot, granted, capabilities, pending, sharedSession, fleet, worldCallbacks, route, navigate } = console;
  const notify = useSnackbar();
  const rowPending = pendingFor(pending, world.id);
  const busy = rowPending !== null;
  // The page tells this world's own session, never the game's (ADR-0062).
  const state = worldState(game, world, sharedSession);
  const operations = operationsBlockingWorld(snapshot, world);
  const shown = useWorldTabs(console, game, world, notify);
  const offersProgress = capabilities.has("operationProgress");
  const running = newestRunning(snapshot?.operations ?? [], world.id);
  const progress = progressModel(offersProgress ? running : null, useOperationProgress(offersProgress ? { gameId: game.id, worldId: world.id } : null, running, undefined, () => void console.refresh(true)));
  const canDownload = granted.has("backup.download") && capabilities.has("backupDownloads");
  const backups = useBackups(game.id, world, {
    canRead: granted.has("backup.read"),
    canRestore: granted.has("backup.restore"),
    busy,
    settled: `${world.wipes.length}:${operations.length}`,
    onRestore: (entry) => worldCallbacks.onWorldAction(game, world, "restore", { key: entry.key, name: entry.archiveName, release: entry.release }),
    onDownload: canDownload ? (entry) => console.downloadBackup(game, world, entry) : null,
  });
  const model: WorldModel = {
    game,
    world,
    worldsHref: routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: null }),
    availability: worldStatus(world),
    sessionStatus: sessionStatus(state),
    notices: worldNotices(world),
    tabs: shown.tabs,
    tab: route.worldTab,
    setTab: (tab) => navigate({ worldTab: tab }),
    session: worldSessionVerb(console, game, world),
    refresh: refreshAction(console),
    invite: granted.has("invitation.send") ? action("world.invite", t("common.invitePlayers"), () => worldCallbacks.onInvite(game, world), { icon: "send" }) : null,
    more: worldMoreActions(game, world, granted, busy, worldCallbacks),
    sessionDetails: sessionDetails(game, world, sharedSession, snapshot, state, fleet),
    worldDetails: worldDetails(game, world, state),
    operations: operations.filter((operation) => operation.id !== progress?.id).map((operation) => ({ operation, label: operationLabel(operation.type) })),
    progress,
    wipes: [...world.wipes].reverse().map((wipe) => ({ wipe, showBackups: action("wipe.backups", t("common.backups"), () => { backups.setFilter(wipe.id); navigate({ worldTab: "backups" }); }, { icon: "backup" }) })),
    backups,
    releases: {
      rows: withReleasePacks(
        releaseRows(world, granted.has("connection.read"), busy, () => worldCallbacks.onDownloadPack(game, world)),
        shown.mods?.split && world.preset ? shown.mods.release : null,
        (release, pack) => { if (world.preset) console.downloadReleasePack(game, world.preset.id, release, pack); },
      ),
      state: world.release.state,
      mods: shown.mods,
      changes: shown.changes,
    },
    whitelist: shown.whitelist,
    config: shown.config,
    log: shown.log,
    console: shown.console,
    metrics: shown.metrics,
    siblings: worldRows(console).map(siblingRow),
    glance: {
      live: state === "running",
      players: worldPlayers(game, world, sharedSession),
      address: addressFacts(world),
      launchedAt: worldLaunchedAt(game, world, sharedSession, snapshot),
      busy: busy || operations.length > 0,
    },
  };
  return <skin.World model={model} />;
}

const consoleStatuses: Readonly<Record<ConsoleEntry["status"], StatusDescriptor>> = {
  pending: { kind: "progress", label: t("app.waitingGame") },
  succeeded: { kind: "ok", label: t("app.answered") },
  failed: { kind: "error", label: t("common.noAnswer") },
  unavailable: { kind: "warning", label: t("app.noConsoleHost") },
  timed_out: { kind: "error", label: t("common.timedOut") },
};

// A command an agent sent names the person and the agent, so the log shows
// which commands nobody typed in the panel.
export function consoleLine(entry: ConsoleEntry): ConsoleLine {
  // A deleted person's commands keep their id and lose their name.
  const name = entry.displayName ?? t("rcon.deletedUser");
  const who = entry.agent ? t("rcon.nameViaAgent", { name, agent: entry.agent }) : name;
  return { id: entry.id, at: entry.at, who, command: entry.command, status: consoleStatuses[entry.status], output: entry.output, pending: entry.status === "pending" };
}

// The log, newest last as a terminal prints it; none while the world runs nowhere.
function consoleLog(entries: ConsoleGateway["entries"], running: boolean, retry: () => void): ConsoleModel["log"] {
  if (!running) return null;
  if (entries.status === "ready") return { status: "ready", value: [...entries.value].reverse().map(consoleLine) };
  if (entries.status === "error") return { status: "error", error: entries.error, kind: entries.kind, retry: action("console.retry", t("common.tryAgain"), retry) };
  return { status: "loading" };
}

// A world's own console (ADR-0063): it speaks to this world's session and to
// no other, so several worlds of a game running at once never share one.
function useWorldConsole(game: Game, world: World, open: boolean, running: boolean, notify: ReturnType<typeof useSnackbar>): ConsoleModel {
  const [draft, setDraft] = useState("");
  const gateway = useConsoleGateway(open && running ? game.id : undefined, world.id, notify);
  const unavailable = running ? null : t("rcon.worldDisplayNameNotRunningStart", { worldDisplayName: world.displayName });
  const send = (command: string, clear: boolean) => {
    void gateway.run(command).then((accepted) => { if (accepted && clear) setDraft(""); });
  };
  const entries = gateway.entries;
  return {
    game,
    world,
    session: sessionStatus(running ? "running" : "stopped"),
    online: running,
    log: consoleLog(entries, running, gateway.retry),
    draft,
    setDraft,
    run: action("console.run", t("rcon.run"), () => send(draft.trim(), true), {
      icon: "keyboard_return",
      disabled: unavailable !== null || draft.trim() === "" || gateway.sending,
      busy: gateway.sending,
      hint: unavailable ?? undefined,
    }),
    quickCommands: game.consoleSuggestions.map((command) => action("console.quick", command, () => send(command, false), {
      disabled: unavailable !== null || gateway.sending,
      hint: unavailable ?? t("rcon.runCommand", { command }),
    })),
    unavailable,
  };
}

function releasesModel(console: ConsoleController): ReleasesModel {
  const { game, granted, pending, listStatus } = console;
  const canManage = granted.has("world.manage");
  return {
    game,
    loading: listStatus === "loading",
    presets: (game?.presets ?? []).map((preset) => ({
      preset,
      ...presetBuildStates(preset),
      createWorld: game ? action("world.create", t("common.createWorld"), () => console.requestCreateWorld(game, preset), {
        icon: "add",
        disabled: !canManage || startableReleases(preset).length === 0 || pendingOf(pending, "create") !== null,
        hint: createWorldHint(canManage, startableReleases(preset).length > 0),
      }) : null,
      build: game && console.capabilities.has("releaseBuilds") && granted.has("release.build") ? action("release.build", releaseBuildCopy(preset).label, () => console.requestBuild(game, preset), {
        icon: "refresh", disabled: preset.buildAvailable !== true || buildRunning(preset) || pendingOf(pending, "build") !== null,
        busy: pendingOf(pending, "build")?.presetId === preset.id,
        hint: buildHint(preset),
      }) : null,
    })),
    pointers: (game?.worlds ?? []).map((world) => ({
      world,
      href: routeHash({ page: "worlds", accessTab: "users", gameId: game?.id ?? null, worldId: world.id }),
      presetName: game?.presets.find((preset) => preset.id === (world.preset?.id ?? world.profileId))?.displayName ?? world.profileId,
      summary: releaseSummary(world),
    })),
  };
}

/** A build that is under way; a resumable "starting" build still accepts a request. */
function buildRunning(preset: Preset): boolean {
  return preset.buildStatus === "building" && preset.build?.state !== "starting";
}

function buildHint(preset: Preset): string {
  if (preset.buildAvailable !== true) return t("releases.presetSourceSnapshotUnavailable");
  return buildRunning(preset) ? t("error.build_in_progress") : releaseBuildCopy(preset).hint;
}

function createWorldHint(canManage: boolean, ready: boolean): string {
  if (!canManage) return t("common.roleCannotCreateWorlds");
  return ready ? t("releases.createWorldFromPreset") : t("error.preset_release_not_ready");
}

function AccessPage({ console, skin }: Controlled) {
  const { games, directory, bootstrap, granted, route, navigate, notify } = console;
  const rolesModel = useRoles({ directory, granted, notify });
  const users = useUsers({ bootstrap, canInvite: granted.has("access.invite"), directory, notify });
  const notifications = useNotifications(games, notify);
  const { refresh: refreshAccess } = directory;
  useEffect(() => { refreshAccess(); }, [refreshAccess]);
  const model: AccessModel = {
    tab: route.accessTab,
    setTab: (tab) => navigate({ page: "access", accessTab: tab }),
    roleCount: directory.roles.roles.length,
    catalogue: directory.roles.permissions,
    users,
    roles: rolesModel,
    notifications,
  };
  return <skin.Access model={model} />;
}

function ProfilePage({ console, skin, looks }: Controlled & Readonly<{ looks: LookChoices }>) {
  const { directory, session, viewer, appearance, avatar, notify } = console;
  const member = directory.members.find((item) => item.id === session.identity.id) ?? directory.members[0]!;
  const loginAccounts = useLoginAccounts(member.name, notify);
  const open = console.openInBrowser;
  const look: LookModel = {
    current: looks.current,
    options: looks.options.map((option) => ({ ...option, choose: action(`look.${option.id}`, option.name, () => looks.wear(option.id), { disabled: option.id === looks.current, hint: option.id === looks.current ? t("profile.faceWornNow") : t("profile.wearNameFace", { name: option.name }) }) })),
  };
  const locale = currentLocale();
  const language: LookModel = {
    current: locale,
    options: LOCALES.map((id) => ({ id, name: LOCALE_NAMES[id], choose: action(`language.${id}`, LOCALE_NAMES[id], () => speak(id), { disabled: id === locale, hint: id === locale ? t("profile.languageInUse") : undefined }) })),
  };
  return <skin.Profile model={{
    member,
    role: directory.roles.roles.find((role) => role.id === member.roleId),
    viewer,
    avatar: {
      change: action("profile.avatar.change", t("profile.changePictureAction"), () => chooseFile(AVATAR_ACCEPT, avatar.change), { icon: "person", busy: avatar.busy, disabled: avatar.busy }),
      remove: viewer.photoUrl ? action("profile.avatar.remove", t("profile.removePicture"), avatar.remove, { icon: "delete_forever", disabled: avatar.busy }) : null,
    },
    appearance,
    look,
    language,
    signOut: action("profile.signout", t("common.signOut"), console.signOut, { icon: "logout" }),
    openInBrowser: open ? action("profile.browser", t("profile.openInBrowser"), open, { icon: "open_in_new" }) : null,
    loginAccounts,
  }} />;
}

function ConfirmationController({ console, skin }: Controlled) {
  const model = useConfirmationForm(console.confirmation, { onConfirm: console.runConfirmation, onClose: console.closeConfirmation });
  return <skin.ConfirmationDialog model={model} />;
}

function CreateWorldController({ console, skin, game, preset }: Controlled & Readonly<{ game: Game; preset: Game["presets"][number] | null }>) {
  const model = useCreateWorldForm(game, preset, console.snapshot?.deployment, {
    busy: pendingOf(console.pending, "create") !== null,
    onCreate: (chosen, name, release, placement, connectivity, auth) => void console.createWorld(game, chosen, name, release, placement, connectivity, auth),
    onClose: console.closeCreating,
  });
  return <skin.CreateWorldSheet model={model} />;
}

function WorldSettingsController({ console, skin, game, world }: Controlled & Readonly<{ game: Game; world: World }>) {
  const model = useWorldSettingsForm(game, world, console.snapshot?.deployment, {
    busy: console.savingWorldSettings,
    onSave: (placement, connectivity, auth, market) => void console.saveWorldSettings(game, world, placement, connectivity, auth, market),
    onClose: console.closeEditing,
  });
  return <skin.WorldSettingsSheet model={model} />;
}

// Mounted only while the sheet is open, so its drafts start from the world's
// values each time it opens.
function GameSettingsController({ console, skin, game, world }: Controlled & Readonly<{ game: Game; world: World }>) {
  const model = useGameSettingsForm(game, world, {
    busy: console.savingGameSettings,
    onSave: (values) => void console.saveGameSettings(game, world, values),
    onClose: console.closeEditingGameSettings,
  });
  return <skin.GameSettingsSheet model={model} />;
}

// Mounted only while the sheet is open, so its state is created when it opens
// and dropped when it closes.
function InvitationController({ console, skin, game, world }: Controlled & Readonly<{ game: Game; world: World }>) {
  const model = useInvitation(game, world, { onClose: console.closeInvite, notify: console.notify });
  return <skin.InvitationSheet model={model} />;
}
