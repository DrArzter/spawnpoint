import type { ActiveSession } from "../auth";
import { useSnackbar } from "../components/ui/Snackbar";
import { buildStatus, sessionStatus, worldStatus } from "../components/ui/Status";
import type { Game, World } from "../model";
import { routeHash } from "../routing";
import { pendingFor } from "../shell/actions";
import type { Skin } from "../skins/skin";
import { action, type Action } from "./actions";
import { useConsole, type ConsoleController } from "./useConsole";
import { useBackups, useInvitation, useLoginAccounts, useMetrics, useNotifications, useRoles, useUsers } from "./data";
import { useConfirmationForm, useCreateWorldForm, useWorldSettingsForm } from "./forms";
import type { AccessModel, ConsoleModel, ReleasesModel, WorldModel, WorldsModel } from "./models";
import { buildSessionOverview, buildWorldRow, operationLabel, releaseRows, releaseSummary, sessionActionForWorld, sessionControlAvailability, sessionDetails, sharedHostNotice, worldDetails, worldMoreActions, worldNotices, worldTabs } from "./worlds";

/*
 * The controllers: each takes the console's bones, builds one page's model
 * and hands it to the skin's view. A page's own data loads only while that
 * page is shown, which is why these are components and not one hook.
 */

export function ConsoleRoot({ session, skin, continuesBootCard }: Readonly<{ session: ActiveSession; skin: Skin; continuesBootCard: boolean }>) {
  const notify = useSnackbar();
  const console = useConsole(session, continuesBootCard, notify);
  if (!console.booted) return console.bootVisible ? <skin.Boot model={{ title: "Preparing the console", description: "Reading games, worlds and the current AWS state." }} /> : null;
  return (
    <skin.Shell model={console.shell}>
      <CurrentPage console={console} skin={skin} />
      <skin.ScopeDialog model={console.shell.scope} />
      <ConfirmationController console={console} skin={skin} />
      {console.invite && <InvitationController console={console} game={console.invite.game} skin={skin} world={console.invite.world} />}
      {console.creating && <CreateWorldController console={console} game={console.creating.game} preset={console.creating.preset} skin={skin} />}
      {console.editing && <WorldSettingsController console={console} game={console.editing.game} skin={skin} world={console.editing.world} />}
    </skin.Shell>
  );
}

type Controlled = Readonly<{ console: ConsoleController; skin: Skin }>;

function CurrentPage({ console, skin }: Controlled) {
  const { page, game, world } = console;
  if (page === "worlds" && game && world) return <WorldPage console={console} game={game} skin={skin} world={world} />;
  if (page === "worlds") return <WorldsPage console={console} skin={skin} />;
  if (page === "metrics") return <MetricsPage console={console} skin={skin} />;
  if (page === "console") return <skin.Console model={consoleModel(console)} />;
  if (page === "releases") return <skin.Releases model={releasesModel(console)} />;
  if (page === "access") return <AccessPage console={console} skin={skin} />;
  return <ProfilePage console={console} skin={skin} />;
}

function refreshAction(console: ConsoleController): Action {
  return action("refresh", "Refresh", () => void console.refresh(), { icon: "refresh", busy: console.refreshing });
}

function WorldsPage({ console, skin }: Controlled) {
  const { game, snapshot, listStatus, error, granted, pending, sharedSession, serverState, fleetOverview, worldCallbacks } = console;
  const loading = listStatus === "loading";
  const canManage = granted.has("world.manage");
  const readyPreset = game?.presets.some((preset) => preset.buildStatus === "ready") ?? false;
  const controlBusy = pending?.kind === "session" || pending?.kind === "lifecycle";
  const notice = fleetOverview ? null : sharedHostNotice(sharedSession, controlBusy);
  const model: WorldsModel = {
    status: listStatus,
    error,
    game,
    unavailable: !loading && !game ? { failed: listStatus === "error", description: listStatus === "error" ? "Spawnpoint could not read games, worlds and the compute host." : "The control plane lists no games yet. Games and their presets are declared in Git." } : null,
    notices: [
      ...(listStatus === "error" ? [{ id: "load", tone: "error" as const, title: "Current state could not be loaded", description: error, action: action("refresh", "Try again", () => void console.refresh()) }] : []),
      ...(notice ? [notice] : []),
    ],
    overview: buildSessionOverview(game, snapshot, serverState, sharedSession, fleetOverview),
    rows: game ? game.worlds.map((world) => buildWorldRow(game, world, { fleet: fleetOverview, sharedSession, serverState, granted, pending, callbacks: worldCallbacks })) : [],
    emptyDescription: canManage && readyPreset ? "Create the first world from a ready preset." : "Worlds appear here once a preset has a ready release and a world is created.",
    refresh: refreshAction(console),
    createWorld: canManage && readyPreset && game ? action("world.create", "Create world", () => console.requestCreateWorld(game), { icon: "add" }) : null,
  };
  return <skin.Worlds model={model} />;
}

function WorldPage({ console, skin, game, world }: Controlled & Readonly<{ game: Game; world: World }>) {
  const { snapshot, granted, pending, sharedSession, serverState, fleet, worldCallbacks, route, navigate } = console;
  const rowPending = pendingFor(pending, world.id);
  const busy = rowPending !== null;
  const controlBusy = pending?.kind === "session" || pending?.kind === "lifecycle";
  const verb = sessionActionForWorld(world, game, sharedSession, fleet);
  const permitted = granted.has(verb === "start" ? "session.start" : "session.stop");
  const control = sessionControlAvailability(world, game, sharedSession, permitted, controlBusy || busy, fleet);
  const operations = snapshot?.operations ?? [];
  const backups = useBackups(game.id, world, {
    canRead: granted.has("backup.read"),
    canRestore: granted.has("backup.restore"),
    busy,
    settled: `${world.wipes.length}:${operations.length}`,
    onRestore: (entry) => worldCallbacks.onWorldAction(game, world, "restore", { key: entry.key, name: entry.archiveName }),
  });
  const notice = fleet ? null : sharedHostNotice(sharedSession, controlBusy);
  const model: WorldModel = {
    game,
    world,
    worldsHref: routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: null }),
    availability: worldStatus(world),
    notices: [...worldNotices(world, rowPending), ...(notice ? [notice] : [])],
    tabs: worldTabs(world, granted.has("release.read")),
    tab: route.worldTab,
    setTab: (tab) => navigate({ worldTab: tab }),
    session: action(`session.${verb}`, verb === "stop" ? "Stop" : "Start", () => console.requestSession(game, world, verb), {
      icon: verb === "stop" ? "stop" : "play_arrow",
      danger: verb === "stop",
      disabled: control.disabled,
      busy: rowPending?.kind === "session",
      hint: control.hint,
    }),
    refresh: refreshAction(console),
    invite: granted.has("invitation.send") ? action("world.invite", "Invite players", () => worldCallbacks.onInvite(game, world), { icon: "send" }) : null,
    more: worldMoreActions(game, world, granted, busy, worldCallbacks),
    sessionDetails: sessionDetails(game, world, sharedSession, snapshot, serverState, fleet),
    worldDetails: worldDetails(game, world, serverState),
    operations: operations.map((operation) => ({ operation, label: operationLabel(operation.type) })),
    wipes: [...world.wipes].reverse().map((wipe) => ({ wipe, showBackups: action("wipe.backups", "Backups", () => { backups.setFilter(wipe.id); navigate({ worldTab: "backups" }); }) })),
    backups,
    releases: { rows: releaseRows(world, granted.has("connection.read"), busy, () => worldCallbacks.onDownloadPack(game, world)), state: world.release.state },
  };
  return <skin.World model={model} />;
}

function MetricsPage({ console, skin }: Controlled) {
  const model = useMetrics(console.snapshot?.hosts[0]?.id, console.serverState === "running");
  return <skin.Metrics model={model} />;
}

function consoleModel(console: ConsoleController): ConsoleModel {
  return { game: console.game, session: sessionStatus(console.serverState), online: console.serverState === "running", quickCommands: ["list", "save-all", "say Server stops in 5 minutes"] };
}

function releasesModel(console: ConsoleController): ReleasesModel {
  const { game, granted, pending, listStatus } = console;
  const canManage = granted.has("world.manage");
  return {
    game,
    loading: listStatus === "loading",
    presets: (game?.presets ?? []).map((preset) => ({
      preset,
      status: buildStatus(preset.buildStatus),
      createWorld: game ? action("world.create", "Create world", () => console.requestCreateWorld(game, preset), {
        icon: "add",
        disabled: !canManage || preset.buildStatus !== "ready" || pending?.kind === "create",
        hint: !canManage ? "Your role cannot create worlds." : preset.buildStatus !== "ready" ? "This preset has no ready release yet." : "Create a world from this preset",
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

function AccessPage({ console, skin }: Controlled) {
  const { games, members, setMembers, roles, setRoles, bootstrap, granted, route, navigate, notify } = console;
  const rolesModel = useRoles(setRoles);
  const users = useUsers({ bootstrap, canInvite: granted.has("access.invite"), members, roles, rolesLoading: rolesModel.loading, onMembersChange: setMembers, notify });
  const notifications = useNotifications(games, notify);
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

function ProfilePage({ console, skin }: Controlled) {
  const { members, session, roles, viewer, appearance, notify } = console;
  const member = members.find((item) => item.id === session.identity.id) ?? members[0]!;
  const loginAccounts = useLoginAccounts(member.name, notify);
  const open = console.openInBrowser;
  return <skin.Profile model={{
    member,
    role: roles.find((role) => role.id === member.roleId),
    viewer,
    appearance,
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
    busy: console.pending?.kind === "create",
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

// Mounted only while the sheet is open, so its state is created when it opens
// and dropped when it closes.
function InvitationController({ console, skin, game, world }: Controlled & Readonly<{ game: Game; world: World }>) {
  const model = useInvitation(game, world, { onClose: console.closeInvite, notify: console.notify });
  return <skin.InvitationSheet model={model} />;
}
