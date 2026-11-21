import { useEffect, useState } from "react";

import type { ConsoleEntry } from "../api/contract";
import type { ActiveSession } from "../auth";
import { useSnackbar } from "../components/ui/Snackbar";
import type { Game, Preset, World, WorldTab } from "../model";
import { routeHash, type WorldsView } from "../routing";
import { operationsBlockingWorld, runningWorlds, worldSessionId, worldState } from "../session";
import { pendingFor, pendingOf } from "../shell/actions";
import type { Skin } from "../skins/skin";
import { action, type Action } from "./actions";
import { releaseBuildCopy } from "./release-builds";
import { buildStatus, sessionStatus, worldStatus, type StatusDescriptor } from "./status";
import { useConsole, type ConsoleController } from "./useConsole";
import { useAccessRequests, useBackups, useConsoleGateway, type ConsoleGateway, useInvitation, useLoginAccounts, useNotifications, useReleaseMods, useRoles, useUsers, useWhitelist, useWorldMetrics } from "./data";
import { useConfirmationForm, useCreateWorldForm, useGameSettingsForm, useWorldSettingsForm } from "./forms";
import type { AccessModel, ConsoleLine, ConsoleModel, LookModel, OperationRow, ReleasesModel, ShellModel, WorldModel, WorldRow, WorldsModel } from "./models";
import { addressFacts, buildSessionOverview, buildWorldRow, operationLabel, releaseRows, releaseSummary, sessionDetails, siblingRow, withReleasePacks, worldDetails, worldLaunchedAt, worldMoreActions, worldNotices, worldPlayers, worldSessionControl, worldTabs } from "./worlds";

/*
 * The controllers: each takes the console's bones, builds one page's model
 * and hands it to the skin's view. A page's own data loads only while that
 * page is shown, which is why these are components and not one hook.
 */

export type LookChoices = Readonly<{ current: string; options: readonly Readonly<{ id: string; name: string }>[]; wear: (id: string) => void }>;

export function ConsoleRoot({ session, skin, looks, continuesBootCard }: Readonly<{ session: ActiveSession; skin: Skin; looks: LookChoices; continuesBootCard: boolean }>) {
  const notify = useSnackbar();
  const console = useConsole(session, continuesBootCard, notify);
  if (!console.booted) return console.bootVisible ? <skin.Boot model={{ title: "Preparing the console" }} /> : null;
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
  return action("refresh", "Refresh", () => void console.refresh(), { icon: "refresh", busy: console.refreshing });
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
    flash: { operations: gameOperationRows(game, console.snapshot).map((row) => ({ id: row.operation.id, label: row.label, worldName: row.worldName, worldId: row.operation.worldId ?? "", startedAt: row.operation.startedAt })) },
    worldActions: (worldId) => {
      const world = game?.worlds.find((item) => item.id === worldId);
      if (!game || !world) return null;
      return {
        session: worldSessionVerb(console, game, world),
        invite: granted.has("invitation.send") ? action("world.invite", "Invite players", () => worldCallbacks.onInvite(game, world), { icon: "send" }) : null,
      };
    },
  };
}

function presetStatus(preset: Preset): StatusDescriptor {
  return preset.build?.state === "starting" ? { kind: "pending", label: "Awaiting dispatch" } : buildStatus(preset.buildStatus);
}

// The game's running operations, each named by the world it holds.
function gameOperationRows(game: Game | undefined, snapshot: ConsoleController["snapshot"]): OperationRow[] {
  if (!game) return [];
  return (snapshot?.operations ?? []).flatMap((operation) => {
    const world = game.worlds.find((item) => item.id === operation.worldId);
    return world ? [{ operation, label: operationLabel(operation.type), worldName: world.displayName, href: routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: world.id }) }] : [];
  });
}

function WorldsPage({ console, skin }: Controlled) {
  const { game, snapshot, listStatus, error, granted, sharedSession, serverState, fleetOverview, route, notify, setRequestCount } = console;
  const loading = listStatus === "loading";
  const canManage = granted.has("world.manage");
  const readyPreset = game?.presets.some((preset) => preset.releases.length > 0) ?? false;
  const view = route.worldsView;
  const requests = useAccessRequests(view === "overview" && granted.has("access.manage"), notify);
  const requestCount = requests.requests?.status === "ready" ? requests.requests.value.length : null;
  useEffect(() => { if (requestCount !== null) setRequestCount(requestCount); }, [requestCount, setRequestCount]);
  const viewHref = (worldsView: WorldsView) => routeHash({ page: "worlds", accessTab: "users", gameId: game?.id ?? null, worldId: null, worldsView });
  const model: WorldsModel = {
    status: listStatus,
    error,
    game,
    unavailable: !loading && !game ? { failed: listStatus === "error", description: listStatus === "error" ? "Spawnpoint could not read games, worlds and the compute host." : "No games yet. Declare them in Git." } : null,
    notices: [
      ...(listStatus === "error" ? [{ id: "load", tone: "error" as const, title: "Current state could not be loaded", description: error, action: action("refresh", "Try again", () => void console.refresh()) }] : []),
    ],
    overview: buildSessionOverview(game, snapshot, serverState, sharedSession, fleetOverview),
    rows: worldRows(console),
    emptyDescription: canManage && readyPreset ? null : "Worlds appear here once a preset has a ready release.",
    refresh: refreshAction(console),
    createWorld: canManage && readyPreset && game ? action("world.create", "Create world", () => console.requestCreateWorld(game), { icon: "add" }) : null,
    view,
    views: { overview: viewHref("overview"), list: viewHref("list") },
    operations: gameOperationRows(game, snapshot),
    builds: (game?.presets ?? []).map((preset) => ({ preset, status: presetStatus(preset) })),
    requests: requests.requests,
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
  return action(`session.${verb}`, stop ? "Stop" : "Start", () => console.requestSession(game, world, verb), {
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

// A whitelist kept on the world's record (ADR-0066): a game that keeps one, a
// live world with a record, a role and a deployment that manage it.
function whitelistOffered(console: ConsoleController, game: Game, world: World): boolean {
  return console.granted.has("whitelist.manage") && console.capabilities.has("whitelist") && game.whitelist === true &&
    world.worldLifecycleAvailable && world.materialization !== "archived";
}

// The world page's tabs, and what each reads, only while it is open: a closed
// tab costs no host a request.
function useWorldTabs(console: ConsoleController, game: Game, world: World, notify: ReturnType<typeof useSnackbar>) {
  const { granted, capabilities, route } = console;
  const tabs = worldTabs(world, {
    releases: granted.has("release.read"),
    whitelist: whitelistOffered(console, game, world),
    console: granted.has("console.use") && capabilities.has("consoleGateway"),
    metrics: granted.has("metrics.read") && capabilities.has("worldMetrics"),
  });
  const offered = (tab: WorldTab) => tabs.some((item) => item.id === tab);
  const open = (tab: WorldTab) => route.worldTab === tab && offered(tab);
  const running = runningWorlds(game).some((item) => item.id === world.id);
  const consoleModel = useWorldConsole(game, world, open("console"), running, notify);
  const metrics = useWorldMetrics(open("metrics") ? game.id : undefined, world.id, worldSessionId(game, world));
  const whitelist = useWhitelist(game.id, world, open("whitelist"), notify);
  const mods = useReleaseMods(game.id, modsSource(world, open("releases") && capabilities.has("releaseFiles")), (presetId, version, mod) => console.downloadMod(game, presetId, version, mod));
  return {
    tabs,
    mods,
    whitelist: offered("whitelist") ? whitelist : null,
    console: offered("console") ? consoleModel : null,
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
  const canDownload = granted.has("backup.download") && capabilities.has("backupDownloads");
  const backups = useBackups(game.id, world, {
    canRead: granted.has("backup.read"),
    canRestore: granted.has("backup.restore"),
    busy,
    settled: `${world.wipes.length}:${operations.length}`,
    onRestore: (entry) => worldCallbacks.onWorldAction(game, world, "restore", { key: entry.key, name: entry.archiveName }),
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
    invite: granted.has("invitation.send") ? action("world.invite", "Invite players", () => worldCallbacks.onInvite(game, world), { icon: "send" }) : null,
    more: worldMoreActions(game, world, granted, busy, worldCallbacks),
    sessionDetails: sessionDetails(game, world, sharedSession, snapshot, state, fleet),
    worldDetails: worldDetails(game, world, state),
    operations: operations.map((operation) => ({ operation, label: operationLabel(operation.type) })),
    wipes: [...world.wipes].reverse().map((wipe) => ({ wipe, showBackups: action("wipe.backups", "Backups", () => { backups.setFilter(wipe.id); navigate({ worldTab: "backups" }); }, { icon: "backup" }) })),
    backups,
    releases: {
      rows: withReleasePacks(
        releaseRows(world, granted.has("connection.read"), busy, () => worldCallbacks.onDownloadPack(game, world)),
        shown.mods?.split && world.preset ? shown.mods.release : null,
        (release, pack) => { if (world.preset) console.downloadReleasePack(game, world.preset.id, release, pack); },
      ),
      state: world.release.state,
      mods: shown.mods,
    },
    whitelist: shown.whitelist,
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

// What each game's console is most often asked; Factorio's commands start with a slash.
const QUICK_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  minecraft: ["list", "save-all", "say Server stops in 5 minutes"],
  factorio: ["/players online", "/server-save", "/time"],
  zomboid: ["players", "save", "servermsg \"Server stops in 5 minutes\""],
  // The server takes no command from outside the game.
  valheim: [],
  // The server's REST API, in its own words; see server/games/palworld/game.sh.
  palworld: ["metrics", "save", "announce Server stops in 5 minutes"],
};

const consoleStatuses: Readonly<Record<ConsoleEntry["status"], StatusDescriptor>> = {
  pending: { kind: "progress", label: "Waiting for the game" },
  succeeded: { kind: "ok", label: "Answered" },
  failed: { kind: "error", label: "No answer" },
  unavailable: { kind: "warning", label: "No console on this host" },
  timed_out: { kind: "error", label: "Timed out" },
};

// A command an agent sent names the person and the agent, so the log shows
// which commands nobody typed in the panel.
export function consoleLine(entry: ConsoleEntry): ConsoleLine {
  // A deleted person's commands keep their id and lose their name.
  const name = entry.displayName ?? "Deleted user";
  const who = entry.agent ? `${name} via ${entry.agent}` : name;
  return { id: entry.id, at: entry.at, who, command: entry.command, status: consoleStatuses[entry.status], output: entry.output, pending: entry.status === "pending" };
}

// The log, newest last as a terminal prints it; none while the world runs nowhere.
function consoleLog(entries: ConsoleGateway["entries"], running: boolean, retry: () => void): ConsoleModel["log"] {
  if (!running) return null;
  if (entries.status === "ready") return { status: "ready", value: [...entries.value].reverse().map(consoleLine) };
  if (entries.status === "error") return { status: "error", error: entries.error, kind: entries.kind, retry: action("console.retry", "Try again", retry) };
  return { status: "loading" };
}

// A world's own console (ADR-0063): it speaks to this world's session and to
// no other, so several worlds of a game running at once never share one.
function useWorldConsole(game: Game, world: World, open: boolean, running: boolean, notify: ReturnType<typeof useSnackbar>): ConsoleModel {
  const [draft, setDraft] = useState("");
  const gateway = useConsoleGateway(open && running ? game.id : undefined, world.id, notify);
  const unavailable = running ? null : `${world.displayName} is not running. Start it to use its console.`;
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
    run: action("console.run", "Run", () => send(draft.trim(), true), {
      icon: "keyboard_return",
      disabled: unavailable !== null || draft.trim() === "" || gateway.sending,
      busy: gateway.sending,
      hint: unavailable ?? undefined,
    }),
    quickCommands: (QUICK_COMMANDS[game.id] ?? []).map((command) => action("console.quick", command, () => send(command, false), {
      disabled: unavailable !== null || gateway.sending,
      hint: unavailable ?? `Run ${command}`,
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
      status: presetStatus(preset),
      createWorld: game ? action("world.create", "Create world", () => console.requestCreateWorld(game, preset), {
        icon: "add",
        disabled: !canManage || preset.releases.length === 0 || pendingOf(pending, "create") !== null,
        hint: createWorldHint(canManage, preset.releases.length > 0),
      }) : null,
      build: game && console.capabilities.has("releaseBuilds") && granted.has("release.build") ? action("release.build", releaseBuildCopy(preset).label, () => console.requestBuild(game, preset), {
        icon: "refresh", disabled: preset.buildAvailable !== true || (preset.buildStatus === "building" && preset.build?.state !== "starting") || pendingOf(pending, "build") !== null,
        busy: pendingOf(pending, "build")?.presetId === preset.id,
        hint: preset.buildAvailable !== true ? "The preset source snapshot is unavailable for building." : preset.buildStatus === "building" && preset.build?.state !== "starting" ? "A build is already running." : releaseBuildCopy(preset).hint,
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

function createWorldHint(canManage: boolean, ready: boolean): string {
  if (!canManage) return "Your role cannot create worlds.";
  return ready ? "Create a world from this preset" : "This preset has no ready release yet.";
}

function AccessPage({ console, skin }: Controlled) {
  const { games, members, setMembers, roles, setRoles, bootstrap, granted, session, route, navigate, notify } = console;
  const rolesModel = useRoles(setRoles);
  const authority = { selfId: session.identity.id, canDelete: granted.has("access.manage"), canDeleteOwner: granted.has("access.owner.grant") };
  const users = useUsers({ bootstrap, canInvite: granted.has("access.invite"), authority, members, roles, rolesLoading: rolesModel.loading, onMembersChange: setMembers, notify });
  const notifications = useNotifications(games, notify);
  const candidates = users.candidates;
  const requestCount = candidates.status === "ready" ? candidates.value.length : null;
  const { setRequestCount } = console;
  useEffect(() => { if (requestCount !== null) setRequestCount(requestCount); }, [requestCount, setRequestCount]);
  const model: AccessModel = {
    tab: route.accessTab,
    setTab: (tab) => navigate({ page: "access", accessTab: tab }),
    roleCount: roles.length,
    users,
    roles: rolesModel,
    notifications,
  };
  return <skin.Access model={model} />;
}

function ProfilePage({ console, skin, looks }: Controlled & Readonly<{ looks: LookChoices }>) {
  const { members, session, roles, viewer, appearance, notify } = console;
  const member = members.find((item) => item.id === session.identity.id) ?? members[0]!;
  const loginAccounts = useLoginAccounts(member.name, notify);
  const open = console.openInBrowser;
  const look: LookModel = {
    current: looks.current,
    options: looks.options.map((option) => ({ ...option, choose: action(`look.${option.id}`, option.name, () => looks.wear(option.id), { disabled: option.id === looks.current, hint: option.id === looks.current ? "The face the console wears now" : `Wear the ${option.name} face` }) })),
  };
  return <skin.Profile model={{
    member,
    role: roles.find((role) => role.id === member.roleId),
    viewer,
    appearance,
    look,
    signOut: action("profile.signout", "Sign out", console.signOut, { icon: "logout" }),
    openInBrowser: open ? action("profile.browser", "Open in browser", open, { icon: "open_in_new" }) : null,
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
    onSave: (placement, connectivity, auth) => void console.saveWorldSettings(game, world, placement, connectivity, auth),
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
