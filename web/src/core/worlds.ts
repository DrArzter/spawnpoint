import { hostStatus, sessionStatus, worldStatus, type StatusDescriptor } from "../components/ui/Status";
import { formatDate, repositoryName, shortCommit } from "../lib/format";
import type { ControlPlaneSnapshot, Game, Operation, ServerState, Wipe, World, WorldTab } from "../model";
import { routeHash } from "../routing";
import { playersOnline, sessionReason, sharedSessionOwnerLabel, worldOwnsSharedSession, type SharedHostSession } from "../session";
import type { Pending, SessionAction, WorldActionKind } from "../shell/actions";
import { pendingFor } from "../shell/actions";
import { action, type Action } from "./actions";
import type { AddressFacts, Detail, Notice, SessionOverview, WorldRow } from "./models";

/*
 * What the Worlds list and the world page know that no skin should have to
 * work out again: which verb a world takes, why it may be refused, what stands
 * in an empty cell, and what each row may do. Pure functions over the snapshot.
 */

export function releaseSummary(world: World): string {
  const { activeRelease, desiredRelease, state } = world.release;
  if (state === "unavailable") return "Build status could not be loaded";
  if (activeRelease && desiredRelease && activeRelease !== desiredRelease) return `Active ${activeRelease} · desired ${desiredRelease}`;
  if (activeRelease) return `Release ${activeRelease}`;
  if (desiredRelease) return "Ready for first start";
  if (world.materialization === "not_created") return world.preset?.buildStatus === "ready" ? `First start uses ${world.preset.latestRelease ?? "the latest release"}` : `Preset ${world.preset?.buildStatus ?? "unbuilt"}`;
  if (state === "unconfigured") return "No release selected";
  return "No build selected";
}

export function sessionActionForWorld(world: World, game: Game, sharedSession: SharedHostSession, fleet = false): SessionAction {
  if (fleet) return game.lifecycle?.activeWorldId === world.id && game.lifecycle.activeSessionId ? "stop" : "start";
  return worldOwnsSharedSession(sharedSession, game, world) && sharedSession.state !== "stopped" ? "stop" : "start";
}

export function sessionControlAvailability(world: World, game: Game, sharedSession: SharedHostSession, permitted: boolean, controlBusy: boolean, fleet = false): { action: SessionAction; disabled: boolean; hint: string } {
  const action = sessionActionForWorld(world, game, sharedSession, fleet);
  if (!world.sessionControlAvailable) {
    if (world.materialization === "archived") return { action, disabled: true, hint: "This world is archived. Restore a backup to open a new wipe." };
    if (world.materialization === "not_created") return { action, disabled: true, hint: "This preset needs a successful release build before its first start." };
    return { action, disabled: true, hint: "This world is not connected to a session workflow yet." };
  }
  if (!permitted) return { action, disabled: true, hint: `Your role cannot ${action} sessions.` };
  if (controlBusy || sharedSession.operationRunning) return { action, disabled: true, hint: "A control-plane operation is already in progress." };
  if (fleet) {
    const lifecycle = game.lifecycle;
    if (world.connectivity === "zerotier") return { action, disabled: true, hint: "Fleet hosts do not join ZeroTier. Choose a public connection while this world is stopped." };
    if (lifecycle?.observedState === "starting" || lifecycle?.observedState === "stopping" || lifecycle?.observedState === "unknown") return { action, disabled: true, hint: `This game is ${lifecycle.observedState}.` };
    if (action === "start" && lifecycle?.activeSessionId) return { action, disabled: true, hint: "Another world of this game is already active. Stop it first." };
    return { action, disabled: false, hint: action === "start" ? "Launch or reuse a billed fleet host" : "Save and back up this session, then drain its host" };
  }
  if (sharedSession.recoveryPending) return { action, disabled: true, hint: "Spawnpoint is reconciling the stopped host automatically." };
  if (sharedSession.state === "starting" || sharedSession.state === "stopping") return { action, disabled: true, hint: `The shared host is ${sharedSession.state}.` };
  if (sharedSession.state === "unknown") return { action, disabled: true, hint: "Spawnpoint cannot confirm that the shared host is free. Refresh before trying again." };
  if (action === "start" && sharedSession.state === "running") {
    const owner = sharedSessionOwnerLabel(sharedSession);
    return { action, disabled: true, hint: owner ? `${owner} is using the shared host. Stop that session first.` : "Another session is using the shared host. Stop it first." };
  }
  return { action, disabled: false, hint: action === "start" ? "Start a billed session on the shared host" : "Save, back up and stop this session" };
}

export function addressFacts(world: World): AddressFacts | null {
  if (!world.connectionAddress) return null;
  const zerotier = world.connectivity === "zerotier";
  return {
    value: world.connectionAddress,
    connectivity: world.connectivity,
    network: zerotier ? "ZeroTier network. Reachable only from a device that joined the overlay." : "Public address. Reachable from the internet.",
  };
}

export function missingAddressLabel(world: World, serverState: ServerState): string {
  if (world.materialization !== "existing") return "No address";
  return serverState === "running" ? "No address yet" : "Assigned while online";
}

export function sharedHostNotice(session: SharedHostSession, busy: boolean): Notice | null {
  const owner = sharedSessionOwnerLabel(session);
  if (session.recoveryPending) {
    return { id: "recovery", tone: "info", title: "Automatic recovery in progress", description: owner ? `${owner} still owns the recorded session, although the compute host is stopped. Spawnpoint is reconciling it automatically; session controls remain locked until it finishes.` : "The compute host is stopped and Spawnpoint is reconciling its session record automatically." };
  }
  if (busy || session.operationRunning || session.state === "starting" || session.state === "stopping") {
    return { id: "operation", tone: "info", title: "Shared host operation in progress", description: owner ? `${owner} owns the current session. Session controls stay locked until the operation finishes.` : "Session controls stay locked until the current operation finishes." };
  }
  if (session.state === "running") {
    return { id: "occupied", tone: "info", title: "Shared host is occupied", description: owner ? `${owner} is running. Stop that session before starting another world.` : "A session is running, but its world is not reported. Session starts stay locked for safety." };
  }
  if (session.state === "unknown") {
    return { id: "unknown", tone: "warning", title: "Shared host availability is unknown", description: "Spawnpoint cannot prove that the shared host is free. Refresh the control-plane state before starting a world." };
  }
  return null;
}

function fleetReason(game: Game | undefined): string {
  const state = game?.lifecycle?.observedState;
  if (state === "ready") return "This game's world is running on a fleet host.";
  if (state === "starting") return "A fleet host is being assigned or the game is starting.";
  if (state === "stopping") return "The game is saving and its host is draining.";
  if (state === "unknown") return "Spawnpoint cannot confirm this game's state.";
  return "No session for this game. Fleet hosts launch on demand.";
}

export function buildSessionOverview(game: Game | undefined, snapshot: ControlPlaneSnapshot | null, serverState: ServerState, sharedSession: SharedHostSession, fleet: boolean): SessionOverview {
  const host = snapshot?.hosts[0];
  const status = sessionStatus(serverState);
  const reason = sessionReason(sharedSession, game);
  const hosts = snapshot?.hosts ?? [];
  return {
    fleet,
    state: serverState,
    status,
    headline: `${game?.displayName ?? "Session"} ${status.label.toLowerCase()}`,
    reason: fleet ? { text: fleetReason(game), detail: reason.detail, attention: false } : reason,
    players: playersOnline(game),
    observedAt: snapshot?.observedAt,
    host: host ? { name: host.name, status: hostStatus(host.state), instanceType: host.instanceType ?? null, zone: host.availabilityZone ?? null, launchedAt: host.launchedAt ?? null } : null,
    fleetHosts: {
      running: hosts.filter((item) => item.provenance === "launched" && item.state === "running").length,
      pending: hosts.filter((item) => item.provenance === "launched" && item.state === "pending").length,
    },
  };
}

export type WorldCallbacks = Readonly<{
  onWorldAction: (game: Game, world: World, action: WorldActionKind, backup?: { key: string; name: string }) => void;
  onInvite: (game: Game, world: World) => void;
  onDownloadPack: (game: Game, world: World) => void;
  onEditSettings?: (game: Game, world: World) => void;
}>;

export function presetOf(game: Game, world: World) {
  return game.presets.find((item) => item.id === (world.preset?.id ?? world.profileId));
}

/** The row's own verbs, in the order a menu lists them. Start and stop are not here: they spend money, and the world page can say why they are refused. */
export function rowActions(game: Game, world: World, granted: ReadonlySet<string>, busy: boolean, callbacks: WorldCallbacks): Action[] {
  const items: Action[] = [
    action("world.details", "View details", () => { window.location.hash = routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: world.id }); }, { icon: "chevron_right" }),
  ];
  if (granted.has("invitation.send")) items.push(action("world.invite", "Invite players", () => callbacks.onInvite(game, world), { icon: "send" }));
  if (granted.has("connection.read")) items.push(packAction(game, world, busy, callbacks));
  if (!granted.has("world.manage") || !world.worldLifecycleAvailable) return items;
  items.push(...lifecycleActions(game, world, busy, callbacks));
  return items;
}

function packAction(game: Game, world: World, busy: boolean, callbacks: WorldCallbacks): Action {
  return action("world.pack", "Download client pack", () => callbacks.onDownloadPack(game, world), {
    icon: "download",
    disabled: !world.release.activeRelease || busy,
    hint: world.release.activeRelease ? `Pack for release ${world.release.activeRelease}` : "Available once a release is active",
  });
}

function lifecycleActions(game: Game, world: World, busy: boolean, callbacks: WorldCallbacks): Action[] {
  const items: Action[] = [];
  const preset = presetOf(game, world);
  if (world.materialization === "existing") {
    items.push(action("world.wipe", "Start a new wipe", () => callbacks.onWorldAction(game, world, "wipe"), { icon: "history", disabled: busy || !preset?.latestRelease, detail: preset?.latestRelease ? `From ${preset.displayName} ${preset.latestRelease}` : "Needs a built release" }));
    items.push(action("world.archive", "Archive", () => callbacks.onWorldAction(game, world, "archive"), { icon: "archive", disabled: busy, detail: "Stops, backs up, hides from session control" }));
  }
  if (world.materialization === "archived") items.push(action("world.purge", "Delete permanently", () => callbacks.onWorldAction(game, world, "purge"), { icon: "delete_forever", danger: true, disabled: busy, detail: "Registry, pointer and every backup" }));
  return items;
}

/** The world page's overflow: what the list has, plus hosting, minus details and invite (which the page shows on its own). */
export function worldMoreActions(game: Game, world: World, granted: ReadonlySet<string>, busy: boolean, callbacks: WorldCallbacks): Action[] {
  const items: Action[] = [];
  if (granted.has("connection.read")) items.push(packAction(game, world, busy, callbacks));
  if (!granted.has("world.manage") || !world.worldLifecycleAvailable) return items;
  if (world.materialization !== "archived" && callbacks.onEditSettings) {
    const edit = callbacks.onEditSettings;
    items.push(action("world.settings", "Hosting & connection", () => edit(game, world), { icon: "dns", disabled: busy }));
  }
  items.push(...lifecycleActions(game, world, busy, callbacks));
  return items;
}

export function buildWorldRow(game: Game, world: World, opts: Readonly<{ fleet: boolean; sharedSession: SharedHostSession; serverState: ServerState; granted: ReadonlySet<string>; pending: Pending | null; callbacks: WorldCallbacks }>): WorldRow {
  const active = opts.fleet
    ? game.lifecycle?.activeWorldId === world.id && game.lifecycle.observedState === "ready"
    : worldOwnsSharedSession(opts.sharedSession, game, world) && opts.sharedSession.state === "running";
  const wipe = world.wipes.find((item) => item.state === "current") ?? world.wipes.at(-1);
  return {
    world,
    href: routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: world.id }),
    status: active ? sessionStatus("running") : worldStatus(world),
    presetName: presetOf(game, world)?.displayName ?? world.profileId,
    releaseSummary: releaseSummary(world),
    wipe: wipe ? { number: wipe.number, openedAt: formatDate(wipe.createdAt) } : null,
    wipeAbsent: world.worldLifecycleAvailable ? "No wipes yet" : "Legacy world",
    address: addressFacts(world),
    addressAbsent: missingAddressLabel(world, opts.serverState),
    actions: rowActions(game, world, opts.granted, pendingFor(opts.pending, world.id) !== null, opts.callbacks),
  };
}

export function worldTabs(world: World, canReadReleases: boolean): { id: WorldTab; label: string; count?: number }[] {
  const tabs: { id: WorldTab; label: string; count?: number }[] = [{ id: "details", label: "Details" }];
  if (world.worldLifecycleAvailable) tabs.push({ id: "wipes", label: "Wipes", count: world.wipes.length });
  tabs.push({ id: "backups", label: "Backups" });
  if (canReadReleases) tabs.push({ id: "releases", label: "Releases" });
  return tabs;
}

export function sessionDetails(game: Game, world: World, sharedSession: SharedHostSession, snapshot: ControlPlaneSnapshot | null, serverState: ServerState, fleet: boolean): Detail[] {
  const host = snapshot?.hosts[0];
  const session = sessionStatus(serverState);
  const reason = sessionReason(sharedSession, game, world);
  const players = playersOnline(game);
  const idleAt = game.lifecycle?.idle?.lastObservedAtEpochSeconds ?? null;
  const running = snapshot?.hosts.filter((item) => item.provenance === "launched" && item.state === "running").length ?? 0;
  return [
    {
      label: "Session",
      value: { type: "status", status: session },
      hint: fleet ? (game.lifecycle?.activeWorldId === world.id ? "This world owns the current game session." : "This world has no active session.") : reason.text,
      hintAttention: !fleet && reason.attention,
      explain: fleet ? "A fleet host launches when a session needs one and drains after its last session." : `${game.displayName} runs one session at a time on the shared host. ${reason.detail}`,
    },
    fleet
      ? { label: "Fleet", value: { type: "text", text: `${running} running hosts` } }
      : { label: "Compute host", value: host ? { type: "status", status: { kind: hostStatus(host.state).kind, label: `${host.name} · ${hostStatus(host.state).label.toLowerCase()}` } } : { type: "absent", text: "No host available" }, hint: host?.instanceType ? `${host.instanceType}${host.availabilityZone ? ` in ${host.availabilityZone}` : ""}` : undefined },
    ...(!fleet && host ? [{ label: "Launched", value: host.launchedAt ? { type: "time" as const, at: host.launchedAt } : { type: "absent" as const, text: "Not running" } }] : []),
    ...(players === null ? [] : [{ label: "Players online", value: { type: "number" as const, value: players }, hint: idleAt === null ? undefined : "Counted", hintTime: idleAt }]),
    { label: "Last observed", value: { type: "time", at: snapshot?.observedAt } },
  ];
}

export function worldDetails(game: Game, world: World, serverState: ServerState): Detail[] {
  const preset = presetOf(game, world);
  const currentWipe = world.wipes.find((wipe) => wipe.state === "current") ?? world.wipes.at(-1);
  const hasRelease = Boolean(world.release.activeRelease || world.release.desiredRelease);
  const availability = worldStatus(world);
  const address = addressFacts(world);
  return [
    { label: "World ID", value: { type: "text", text: world.id, mono: true }, copy: world.id },
    { label: "Availability", value: { type: "status", status: availability }, hint: world.worldLifecycleAvailable ? undefined : "Legacy world without wipe management" },
    { label: "Preset", value: { type: "text", text: preset?.displayName ?? world.profileId }, hint: world.preset ? `${repositoryName(world.preset.repository)} @ ${shortCommit(world.preset.commit)}` : "Not built from a Git preset" },
    { label: "Release", value: hasRelease ? { type: "release", active: world.release.activeRelease, desired: world.release.desiredRelease } : { type: "absent", text: releaseSummary(world) }, explain: "The release this world runs, next to the one it is asked to run." },
    { label: "Current wipe", value: currentWipe ? { type: "text", text: `#${currentWipe.number}` } : { type: "absent", text: world.worldLifecycleAvailable ? "No wipes yet" : "Not tracked" }, explain: "One wipe is one generation of this world. A new one keeps every backup of the old one.", hint: currentWipe ? `Opened ${formatDate(currentWipe.createdAt)} · release ${currentWipe.originRelease}` : undefined },
    { label: "Address", value: address ? { type: "address", address } : { type: "absent", text: missingAddressLabel(world, serverState) }, copy: world.connectionAddress ?? undefined },
    { label: "Hosting", value: { type: "text", text: world.placement === "fleet" ? "On-demand fleet" : "Persistent host" }, hint: world.placement === "fleet" ? "A disposable host is allocated for each session." : "Uses the configured long-lived host." },
    { label: "Connection", value: { type: "text", text: world.connectivity === "zerotier" ? "ZeroTier" : world.connectivity === "route53" ? "Public DNS" : "Public IP" } },
  ];
}

export function operationLabel(type: Operation["type"]): string {
  return type === "start" ? "Starting session" : type === "stop" ? "Stopping session" : type === "world" ? "Updating world" : "Promoting release";
}

export function worldNotices(world: World, pending: Pending | null): Notice[] {
  const notices: Notice[] = [];
  if (world.materialization === "archived") notices.push({ id: "archived", tone: "warning", title: "This world is archived", description: "Restore one of its backups to open a new wipe, or delete it permanently from the actions menu." });
  if (pending?.kind === "lifecycle") {
    const operation = pending.action === "wipe" ? "a new wipe" : pending.action;
    notices.push({ id: "operation", tone: "info", title: "World operation in progress", description: `Spawnpoint is requesting ${operation}. The operation appears in the table below once accepted.` });
  }
  return notices;
}

export function releaseRows(world: World, canDownload: boolean, busy: boolean, download: () => void): Array<{ name: string; status: string; downloadable: boolean; download: Action | null }> {
  const map = new Map<string, { name: string; status: string; downloadable: boolean }>();
  if (world.release.activeRelease) map.set(world.release.activeRelease, { name: world.release.activeRelease, status: "Active", downloadable: true });
  if (world.release.desiredRelease) {
    map.set(world.release.desiredRelease, {
      name: world.release.desiredRelease,
      status: world.release.desiredRelease === world.release.activeRelease ? "Active and desired" : "Desired",
      downloadable: world.release.desiredRelease === world.release.activeRelease,
    });
  }
  return [...map.values()].map((row) => ({
    ...row,
    download: row.downloadable && canDownload ? action("world.pack", "Download", download, { icon: "download", disabled: busy, hint: "Client pack for this release" }) : null,
  }));
}

export function wipeStatus(wipe: Wipe): StatusDescriptor {
  return wipe.state === "current" ? { kind: "ok", label: "Current" } : { kind: "off", label: "Closed" };
}
