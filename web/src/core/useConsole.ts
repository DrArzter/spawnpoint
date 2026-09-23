import { useCallback, useEffect, useMemo, useState } from "react";

import { ActiveSession, endSession, loadAppearance, loadControlPlane, requestCreateWorld, requestPackDownload, requestSessionOperation, requestUpdateWorldSettings, requestWorldLifecycle, subscribeControlPlane, updateAppearance } from "../auth";
import { sessionStatus } from "../components/ui/Status";
import { formatDateTime } from "../lib/format";
import type { ControlPlaneSnapshot, Game, Member, OwnerBootstrap, Page, Preset, Role, ServerState, World } from "../model";
import { routeHash, type AppRoute } from "../routing";
import { deriveSharedHostSession, type SharedHostSession } from "../session";
import type { Confirmation, Pending, SessionAction, WorldActionKind } from "../shell/actions";
import { useAppearance, useBootCard, useRoute, useStoredState } from "../shell/hooks";
import { initializeTelegram, openInBrowser, type ViewerProfile } from "../telegram";
import { action } from "./actions";
import type { Notify } from "./data";
import type { AppearanceModel, NavigationItem, ShellModel, WorldPlacement } from "./models";
import type { WorldCallbacks } from "./worlds";

/*
 * The console's bones: what is loaded, what is pending, what is open, and
 * what every page may ask for. Nothing here knows how any of it looks.
 */

// A screen is offered when the role may use it and the deployment routes it.
// `capability` is absent where a screen needs nothing from the API it does not
// already get from the control-plane snapshot.
const navigation: readonly { id: Page; label: string; permission: string; capability?: string }[] = [
  { id: "worlds", label: "Worlds", permission: "status.read" },
  { id: "metrics", label: "Metrics", permission: "metrics.read" },
  { id: "console", label: "Console", permission: "console.use" },
  { id: "releases", label: "Releases", permission: "release.read" },
  { id: "access", label: "Access", permission: "access.read" },
];

type ControlPlaneState =
  | { status: "loading"; snapshot: ControlPlaneSnapshot | null; error: "" }
  | { status: "ready"; snapshot: ControlPlaneSnapshot; error: "" }
  | { status: "error"; snapshot: ControlPlaneSnapshot | null; error: string };

export function deriveServerState(game: Game | undefined, snapshot: ControlPlaneSnapshot | null): ServerState {
  if (snapshot?.deployment?.placement === "fleet") {
    const observed = game?.lifecycle?.observedState;
    return observed === "ready" ? "running" : observed ?? "stopped";
  }
  const operation = snapshot?.operations[0];
  if (operation?.type === "start") return "starting";
  if (operation?.type === "stop") return "stopping";
  const observed = game?.lifecycle?.observedState;
  if (observed === "ready") return "running";
  if (observed === "starting" || observed === "stopping" || observed === "stopped" || observed === "unknown") return observed;
  const hostStates = snapshot?.hosts.map((host) => host.state) ?? [];
  if (hostStates.includes("pending")) return "starting";
  if (hostStates.includes("stopping")) return "stopping";
  if (hostStates.includes("running")) return "unknown";
  return hostStates.length > 0 ? "stopped" : "unknown";
}

const lifecycleLabels: Record<WorldActionKind, string> = { wipe: "New wipe", archive: "Archive", restore: "Restore", purge: "Delete" };

function lifecycleLabel(kind: WorldActionKind): string {
  return lifecycleLabels[kind];
}

function listStatusOf(controlPlane: ControlPlaneState): "loading" | "ready" | "error" {
  if (controlPlane.status === "loading" && controlPlane.snapshot === null) return "loading";
  return controlPlane.status === "error" ? "error" : "ready";
}

function viewerOf(session: ActiveSession): ViewerProfile {
  return {
    displayName: session.identity.displayName,
    inTelegram: Boolean(window.Telegram?.WebApp.initData),
    provider: session.profile.provider,
    ...(session.profile.username ? { username: session.profile.username } : {}),
    ...(session.profile.email ? { email: session.profile.email } : {}),
    ...(session.profile.photoUrl ? { photoUrl: session.profile.photoUrl } : {}),
    ...(session.profile.telegramId ? { telegramId: session.profile.telegramId } : {}),
  };
}

function bootstrapOf(session: ActiveSession): OwnerBootstrap {
  return session.bootstrap.state === "claimed"
    ? { state: "claimed", telegramId: session.bootstrap.telegramId, ownerId: session.bootstrap.ownerId, claimedAt: formatDateTime(session.bootstrap.claimedAt) }
    : { state: "unclaimed", telegramId: session.profile.telegramId };
}

// A game whose active world runs on the fleet, or that has only fleet worlds and
// no session, is read as a fleet game on the Worlds page.
function fleetOverviewOf(game: Game | undefined): boolean {
  if (!game) return false;
  const active = game.worlds.find((item) => item.id === game.lifecycle?.activeWorldId);
  if (active) return active.placement === "fleet";
  return !game.lifecycle?.activeSessionId && game.worlds.some((item) => item.placement === "fleet");
}

export type ConsoleController = Readonly<{
  booted: boolean;
  bootVisible: boolean;
  shell: ShellModel;
  route: AppRoute;
  navigate: (patch: Partial<AppRoute>, options?: { replace?: boolean }) => void;
  page: Page;
  session: ActiveSession;
  viewer: ViewerProfile;
  granted: ReadonlySet<string>;
  snapshot: ControlPlaneSnapshot | null;
  listStatus: "loading" | "ready" | "error";
  error: string;
  games: readonly Game[];
  game: Game | undefined;
  world: World | undefined;
  fleet: boolean;
  fleetOverview: boolean;
  serverState: ServerState;
  sharedSession: SharedHostSession;
  pending: Pending | null;
  refresh: (silent?: boolean) => Promise<void>;
  refreshing: boolean;
  worldCallbacks: WorldCallbacks;
  requestSession: (game: Game, world: World, action: SessionAction) => void;
  requestCreateWorld: (game: Game, preset?: Preset | null) => void;
  members: Member[];
  setMembers: (members: Member[]) => void;
  roles: Role[];
  setRoles: (roles: Role[]) => void;
  bootstrap: OwnerBootstrap;
  appearance: AppearanceModel;
  signOut: () => void;
  openInBrowser: (() => void) | null;
  // What is open over the page, and how each closes and commits.
  confirmation: Confirmation | null;
  closeConfirmation: () => void;
  runConfirmation: (confirmation: Confirmation, release?: string) => void;
  invite: { game: Game; world: World } | null;
  closeInvite: () => void;
  creating: { game: Game; preset: Preset | null } | null;
  closeCreating: () => void;
  createWorld: (game: Game, preset: Preset, name: string, release: string, placement: WorldPlacement, connectivity: World["connectivity"], auth?: "game") => Promise<void>;
  editing: { game: Game; world: World } | null;
  closeEditing: () => void;
  saveWorldSettings: (game: Game, world: World, placement: WorldPlacement, connectivity: World["connectivity"], auth?: "game") => Promise<void>;
  savingWorldSettings: boolean;
  notify: Notify;
}>;

export function useConsole(session: ActiveSession, continuesBootCard: boolean, notify: Notify): ConsoleController {
  const [route, navigate] = useRoute();
  // The console only exists for a signed-in person, so every change here is
  // the account's to keep. The front door has no session and syncs nothing.
  const appearance = useAppearance({ sync: updateAppearance });
  const [storedGame, setStoredGame] = useStoredState<string>("spawnpoint.scope", "");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [controlPlane, setControlPlane] = useState<ControlPlaneState>({ status: "loading", snapshot: null, error: "" });
  const [booted, setBooted] = useState(false);
  const { visible: bootVisible, publish } = useBootCard(continuesBootCard);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [invite, setInvite] = useState<{ game: Game; world: World } | null>(null);
  const [creating, setCreating] = useState<{ game: Game; preset: Preset | null } | null>(null);
  const [editing, setEditing] = useState<{ game: Game; world: World } | null>(null);
  const [savingWorldSettings, setSavingWorldSettings] = useState(false);

  const granted = useMemo(() => new Set([...(session.role?.permissions ?? []), ...session.identity.directGrants]), [session]);
  const capabilities = useMemo(() => new Set(session.capabilities), [session]);
  const snapshot = controlPlane.snapshot;
  const games = snapshot?.games ?? [];
  const game = games.find((item) => item.id === route.gameId) ?? games.find((item) => item.id === storedGame) ?? games[0];
  const world = route.page === "worlds" && route.worldId ? game?.worlds.find((item) => item.id === route.worldId) : undefined;
  const fleet = world?.placement === "fleet";
  const fleetOverview = fleetOverviewOf(game);
  const serverState = deriveServerState(game, snapshot);
  const sharedSession = deriveSharedHostSession(snapshot);
  const scoped = (page: Page) => routeHash({ page, accessTab: route.accessTab, gameId: game?.id ?? null, worldId: null });
  const navItems = navigation
    .filter((item) => granted.has(item.permission) && (item.capability === undefined || capabilities.has(item.capability)))
    .map((item) => ({ id: item.id, label: item.label, href: scoped(item.id) }));
  const page: Page = route.page === "profile" || navItems.some((item) => item.id === route.page) ? route.page : "worlds";

  const [members, setMembers] = useState<Member[]>(() => [{ id: session.identity.id, name: session.identity.displayName, roleId: session.identity.roleId, links: [] }]);
  const [roles, setRoles] = useState<Role[]>(() => (session.role ? [{ id: session.role.id, name: session.role.name, description: "Current signed-in role", permissions: session.role.permissions, system: true }] : []));
  const viewer = viewerOf(session);
  const bootstrap = bootstrapOf(session);

  useEffect(() => initializeTelegram(), []);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setPending({ kind: "refresh" });
    setControlPlane((current) => (silent || current.snapshot ? { status: "loading", snapshot: current.snapshot, error: "" } : { status: "loading", snapshot: null, error: "" }));
    try {
      const next = await loadControlPlane();
      setControlPlane({ status: "ready", snapshot: next, error: "" });
    } catch (error) {
      setControlPlane((current) => ({ status: "error", snapshot: current.snapshot, error: error instanceof Error ? error.message : "The control-plane state could not be loaded." }));
    } finally {
      publish(() => setBooted(true));
      if (!silent) setPending((current) => (current?.kind === "refresh" ? null : current));
    }
  }, [publish]);

  useEffect(() => { void refresh(true); }, [refresh]);

  // The browser painted from its own cache; the identity's choice outranks it.
  // A failure here is silent on purpose: a palette is not worth a banner.
  const { adopt } = appearance;
  useEffect(() => {
    let cancelled = false;
    loadAppearance().then((stored) => { if (!cancelled) adopt(stored); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [adopt]);

  // EventBridge updates the projection and the socket carries only an
  // invalidation. Permission-filtered state still comes from the HTTP API.
  useEffect(() => subscribeControlPlane(() => {
    loadControlPlane().then((next) => setControlPlane({ status: "ready", snapshot: next, error: "" })).catch(() => undefined);
  }), []);

  // Keep the scope in the hash and remember it for the next visit.
  useEffect(() => {
    if (!game) return;
    setStoredGame(game.id);
    if (route.page !== "access" && route.page !== "profile" && route.gameId !== game.id) navigate({ gameId: game.id, worldId: route.worldId }, { replace: true });
  }, [game?.id, route.page, route.gameId]);

  async function runSession(target: Game, targetWorld: World, sessionAction: SessionAction) {
    setPending({ kind: "session", worldId: targetWorld.id, action: sessionAction });
    try {
      const result = await requestSessionOperation(target.id, targetWorld.id, sessionAction);
      const verb = sessionAction === "start" ? "Start" : "Stop";
      notify({ tone: "success", message: result.result === "already_stopped" ? "The host is already stopped." : `${verb} of ${targetWorld.displayName} accepted. It appears in Operations while it runs.` });
      await refresh(true);
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : `The ${sessionAction} request failed.` });
    } finally {
      setPending(null);
    }
  }

  async function runLifecycle(target: Game, targetWorld: World, kind: WorldActionKind, backupKey?: string, release?: string) {
    setPending({ kind: "lifecycle", worldId: targetWorld.id, action: kind });
    try {
      await requestWorldLifecycle(target.id, targetWorld.id, kind === "wipe" ? "regenerate" : kind, backupKey, release);
      notify({ tone: "success", message: `${lifecycleLabel(kind)} of ${targetWorld.displayName} accepted. It appears in Operations while it runs.` });
      await refresh(true);
      if (kind === "purge") navigate({ page: "worlds", gameId: target.id, worldId: null });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : `The ${kind} request failed.` });
    } finally {
      setPending(null);
    }
  }

  async function downloadPack(target: Game, targetWorld: World) {
    // Open during the click's user-activation window; waiting for the API
    // first makes valid downloads look like unsolicited pop-ups.
    const downloadWindow = window.open("about:blank", "_blank");
    if (downloadWindow !== null) downloadWindow.opener = null;
    setPending({ kind: "pack", worldId: targetWorld.id });
    try {
      const { release, url } = await requestPackDownload(target.id, targetWorld.id);
      // The link is presigned for an hour and never kept.
      if (downloadWindow !== null) downloadWindow.location.replace(url); else window.location.assign(url);
      notify({ tone: "success", message: `Pack for release ${release} is downloading.` });
    } catch (error) {
      downloadWindow?.close();
      notify({ tone: "error", message: error instanceof Error ? error.message : "The pack link failed." });
    } finally {
      setPending(null);
    }
  }

  async function createWorld(target: Game, preset: Preset, displayName: string, release: string, placement: WorldPlacement, connectivity: World["connectivity"], auth?: "game") {
    setPending({ kind: "create" });
    try {
      const created = await requestCreateWorld(target.id, preset.id, displayName, release, placement, connectivity, auth);
      notify({ tone: "success", message: `${created.displayName} was created from ${preset.displayName} ${release}.` });
      setCreating(null);
      await refresh(true);
      navigate({ page: "worlds", gameId: target.id, worldId: created.id });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "The world could not be created." });
    } finally {
      setPending(null);
    }
  }

  async function saveWorldSettings(target: Game, targetWorld: World, placement: WorldPlacement, connectivity: World["connectivity"], auth?: "game") {
    setSavingWorldSettings(true);
    try {
      await requestUpdateWorldSettings(target.id, targetWorld.id, placement, connectivity, auth);
      notify({ tone: "success", message: `Connection settings for ${targetWorld.displayName} saved.` });
      setEditing(null);
      await refresh(true);
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "World settings could not be saved." });
    } finally {
      setSavingWorldSettings(false);
    }
  }

  const worldCallbacks: WorldCallbacks = {
    onWorldAction: (target, targetWorld, kind, backup) => {
      if (kind === "archive") setConfirmation({ kind: "archive", game: target, world: targetWorld });
      if (kind === "wipe") setConfirmation({ kind: "wipe", game: target, world: targetWorld, preset: target.presets.find((preset) => preset.id === (targetWorld.preset?.id ?? targetWorld.profileId)) ?? null });
      if (kind === "purge") setConfirmation({ kind: "purge", game: target, world: targetWorld });
      if (kind === "restore" && backup) setConfirmation({ kind: "restore", game: target, world: targetWorld, backupKey: backup.key, backupName: backup.name });
    },
    onInvite: (target, targetWorld) => setInvite({ game: target, world: targetWorld }),
    onDownloadPack: (target, targetWorld) => void downloadPack(target, targetWorld),
    onEditSettings: (target, targetWorld) => setEditing({ game: target, world: targetWorld }),
  };

  const appearanceModel: AppearanceModel = {
    preference: appearance.preference,
    theme: appearance.theme,
    accent: appearance.accent,
    label: appearance.label,
    setPreference: appearance.setPreference,
    setAccent: appearance.setAccent,
  };

  const shell: ShellModel = {
    navigation: [...navItems, { id: "profile" as const, label: "Profile", href: "#/profile" }].map((item): NavigationItem => ({ ...item, current: item.id === page })),
    page,
    scope: {
      game,
      games,
      statusOf: (item) => sessionStatus(deriveServerState(item, snapshot)),
      open: scopeOpen,
      show: action("scope.show", game?.displayName ?? "No game", () => setScopeOpen(true), { disabled: games.length === 0, hint: "Select a game" }),
      close: action("scope.close", "Cancel", () => setScopeOpen(false)),
      select: (gameId) => { setScopeOpen(false); navigate({ gameId, worldId: null }); },
    },
    appearance: appearanceModel,
    cycleTheme: action("appearance.cycle", `${appearance.label}. Change theme`, appearance.cycle, { icon: appearance.theme === "dark" ? "light_mode" : "dark_mode" }),
    viewer,
    demo: session.demo === true,
    observedAt: snapshot ? formatDateTime(snapshot.observedAt) : undefined,
    openProfile: action("shell.profile", "Open my profile", () => navigate({ page: "profile" }), { hint: viewer.displayName }),
  };

  return {
    booted,
    bootVisible,
    shell,
    route,
    navigate,
    page,
    session,
    viewer,
    granted,
    snapshot,
    listStatus: listStatusOf(controlPlane),
    error: controlPlane.error,
    games,
    game,
    world,
    fleet,
    fleetOverview,
    serverState,
    sharedSession,
    pending,
    refresh,
    refreshing: pending?.kind === "refresh",
    worldCallbacks,
    requestSession: (target, targetWorld, sessionAction) => setConfirmation({ kind: "session", action: sessionAction, game: target, world: targetWorld }),
    requestCreateWorld: (target, preset) => setCreating({ game: target, preset: preset ?? target.presets.find((item) => item.buildStatus === "ready") ?? null }),
    members,
    setMembers,
    roles,
    setRoles,
    bootstrap,
    appearance: appearanceModel,
    signOut: () => void endSession(),
    openInBrowser: viewer.inTelegram ? openInBrowser : null,
    confirmation,
    closeConfirmation: () => setConfirmation(null),
    runConfirmation: (item, release) => {
      setConfirmation(null);
      if (item.kind === "session") void runSession(item.game, item.world, item.action);
      if (item.kind === "archive") void runLifecycle(item.game, item.world, "archive");
      if (item.kind === "wipe") void runLifecycle(item.game, item.world, "wipe", undefined, release);
      if (item.kind === "restore") void runLifecycle(item.game, item.world, "restore", item.backupKey);
      if (item.kind === "purge") void runLifecycle(item.game, item.world, "purge");
    },
    invite,
    closeInvite: () => setInvite(null),
    creating,
    closeCreating: () => setCreating(null),
    createWorld,
    editing,
    closeEditing: () => setEditing(null),
    saveWorldSettings,
    savingWorldSettings,
    notify,
  };
}
