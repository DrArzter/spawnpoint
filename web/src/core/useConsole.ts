import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { failureKind, type ActiveSession, type ApiFailureKind, type BackupEntry, type ReleaseMod, type ReleasePackName, type StopPlayersPolicy } from "../api/contract";
import { browserAvatarEnvironment, prepareAvatar } from "./avatar-image";
import { useApi } from "../api/context";
import { endSession } from "../api/end-session";
import { startableReleases } from "./presets";
import { sessionStatus } from "./status";
import { capitalize, formatDateTime } from "../lib/format";
import { useAccessDirectory, type AccessDirectory } from "./access-directory";
import type { ControlPlaneSnapshot, Game, OwnerBootstrap, Page, Preset, ServerState, SettingValue, World } from "../model";
import { routeHash, type AppRoute } from "../routing";
import { configuredHosts, deriveSharedHostSession, gameOperations, nextReadingExpiry, operationTransition, worldSessionActive, type SharedHostSession } from "../session";
import { NO_PENDING, pendingOf, withoutPending, withPending, type Confirmation, type Pending, type PendingMap, type SessionAction, type WorldActionKind } from "../shell/actions";
import { useAppearance, useBootCard, useRoute, useStoredState } from "../shell/hooks";
import { initializeTelegram, openInBrowser, type ViewerProfile } from "../telegram";
import { action } from "./actions";
import { releaseBuildExpectation } from "./release-builds";
import type { Notify } from "./notify";
import { openDownload } from "./download";
import type { AppearanceModel, NavigationItem, ShellModel, WorldMarket, WorldPlacement } from "./models";
import { useAssistantChat } from "./assistant-chat";
import { visibleNavigation } from "./navigation";
import { presetOf, stopDisconnect, type WorldCallbacks } from "./worlds";
import { t } from "../i18n";
import { operationNoun } from "../lib/operation-words";

/*
 * The console's bones: what is loaded, what is pending, what is open, and
 * what every page may ask for. Nothing here knows how any of it looks.
 */

type ControlPlaneState =
  | { status: "loading"; snapshot: ControlPlaneSnapshot | null; error: "" }
  | { status: "ready"; snapshot: ControlPlaneSnapshot; error: "" }
  | { status: "error"; snapshot: ControlPlaneSnapshot | null; error: string; kind: ApiFailureKind };

// Several worlds of a game may run at once, each on its own record
// (ADR-0062): the game is online while any of them is.
function fleetServerState(game: Game | undefined): ServerState {
  const observed = new Set([game?.lifecycle?.observedState, ...(game?.worlds ?? []).map((world) => world.session?.observedState)]);
  if (observed.has("ready")) return "running";
  if (observed.has("moving")) return "moving";
  if (observed.has("starting")) return "starting";
  if (observed.has("stopping")) return "stopping";
  if (observed.has("unknown")) return "unknown";
  return "stopped";
}

// With no record to go by, the shared host's own state is the answer.
function hostServerState(snapshot: ControlPlaneSnapshot | null): ServerState {
  const hostStates = configuredHosts(snapshot).map((host) => host.state);
  if (hostStates.includes("pending")) return "starting";
  if (hostStates.includes("stopping")) return "stopping";
  if (hostStates.includes("running")) return "unknown";
  return hostStates.length > 0 ? "stopped" : "unknown";
}

export function deriveServerState(game: Game | undefined, snapshot: ControlPlaneSnapshot | null): ServerState {
  if (snapshot?.deployment?.placement === "fleet") return fleetServerState(game);
  const operation = gameOperations(game, snapshot)[0];
  const transition = operationTransition(operation, operation?.worldId == null ? undefined : game?.lifecycle?.observedState);
  if (transition !== null) return transition;
  const observed = game?.lifecycle?.observedState;
  if (observed === "ready") return "running";
  return observed ?? hostServerState(snapshot);
}

/**
 * Orders control-plane reads: a response is kept only when no later read has
 * been kept already, so a slow earlier read never overwrites a newer snapshot.
 */
export function createLoadSequence() {
  let issued = 0;
  let kept = 0;
  return {
    begin: () => ++issued,
    keep: (ticket: number) => {
      if (ticket < kept) return false;
      kept = ticket;
      return true;
    },
  };
}

// A fleet world has no fixed host, so the answer names the world.
export function sessionAcceptedMessage(world: World, sessionAction: SessionAction, result: "requested" | "already_stopped"): string {
  if (result === "already_stopped") return t("world.worldDisplayNameAlreadyStopped", { worldDisplayName: world.displayName });
  return t("common.valueWorldDisplayNameAcceptedAppears", { value: capitalize(operationNoun(sessionAction)), worldDisplayName: world.displayName });
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
  if (game.worlds.some((item) => item.placement === "fleet" && item.session?.activeSessionId)) return true;
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
  /** What this deployment serves: a page or tab is offered only where its route exists. */
  capabilities: ReadonlySet<string>;
  snapshot: ControlPlaneSnapshot | null;
  listStatus: "loading" | "ready" | "error";
  error: string;
  errorKind: ApiFailureKind;
  games: readonly Game[];
  game: Game | undefined;
  world: World | undefined;
  fleet: boolean;
  fleetOverview: boolean;
  serverState: ServerState;
  sharedSession: SharedHostSession;
  pending: PendingMap;
  refresh: (silent?: boolean) => Promise<void>;
  refreshing: boolean;
  worldCallbacks: WorldCallbacks;
  requestSession: (game: Game, world: World, action: SessionAction) => void;
  requestCreateWorld: (game: Game, preset?: Preset | null) => void;
  requestBuild: (game: Game, preset: Preset) => void;
  /** Asks to delete a persistent host no world is placed on (ADR-0100). */
  requestHostDeletion: (host: Readonly<{ providerRef: string; name: string }>) => void;
  /** Who has access, who waits, and the roles: one answer for the rail's count, the game home and the Access page. */
  directory: AccessDirectory;
  bootstrap: OwnerBootstrap;
  appearance: AppearanceModel;
  signOut: () => void;
  openInBrowser: (() => void) | null;
  // What is open over the page, and how each closes and commits.
  confirmation: Confirmation | null;
  closeConfirmation: () => void;
  runConfirmation: (confirmation: Confirmation, release?: string, keep?: boolean) => void;
  invite: { game: Game; world: World } | null;
  closeInvite: () => void;
  creating: { game: Game; preset: Preset | null } | null;
  closeCreating: () => void;
  createWorld: (game: Game, preset: Preset, name: string, release: string, placement: WorldPlacement, connectivity: World["connectivity"], auth?: "game") => Promise<void>;
  editing: { game: Game; world: World } | null;
  closeEditing: () => void;
  saveWorldSettings: (game: Game, world: World, placement: WorldPlacement, connectivity: World["connectivity"], auth?: "game", market?: WorldMarket) => Promise<void>;
  savingWorldSettings: boolean;
  /** A world's game settings sheet (ADR-0064). */
  editingGameSettings: { game: Game; world: World } | null;
  closeEditingGameSettings: () => void;
  saveGameSettings: (game: Game, world: World, values: Readonly<Record<string, SettingValue>>) => Promise<void>;
  savingGameSettings: boolean;
  /** Short-lived links to a world's archive and a release's mod (ADR-0065). */
  downloadBackup: (game: Game, world: World, entry: BackupEntry) => void;
  downloadMod: (game: Game, presetId: string, release: string, mod: ReleaseMod) => void;
  downloadReleasePack: (game: Game, presetId: string, release: string, pack: ReleasePackName) => void;
  /** The person's own picture: a change shows at once in the app bar, the profile and the access list. */
  avatar: Readonly<{ busy: boolean; change: (file: File) => void; remove: () => void }>;
  notify: Notify;
}>;

export function useConsole(signedIn: ActiveSession, continuesBootCard: boolean, notify: Notify): ConsoleController {
  const api = useApi();
  // The picture is the one part of the session the person changes here.
  const [photoUrl, setPhotoUrl] = useState<string | null | undefined>(undefined);
  const session = useMemo<ActiveSession>(() => (photoUrl === undefined ? signedIn : { ...signedIn, profile: { ...signedIn.profile, photoUrl } }), [signedIn, photoUrl]);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [route, navigate] = useRoute();
  // The console only exists for a signed-in person, so every change here is
  // the account's to keep. The front door has no session and syncs nothing.
  const appearance = useAppearance({ sync: api.updateAppearance });
  const [storedGame, setStoredGame] = useStoredState<string>("spawnpoint.scope", "");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [controlPlane, setControlPlane] = useState<ControlPlaneState>({ status: "loading", snapshot: null, error: "" });
  const [readingClock, setReadingClock] = useState(0);
  useEffect(() => {
    // Redraw when a shown player reading expires, so it turns to unknown on time.
    const expiry = nextReadingExpiry(controlPlane.snapshot);
    if (expiry === null) return undefined;
    const timer = window.setTimeout(() => setReadingClock((tick) => tick + 1), Math.max(0, expiry * 1000 - Date.now()) + 1000);
    return () => window.clearTimeout(timer);
  }, [controlPlane.snapshot, readingClock]);
  const [booted, setBooted] = useState(false);
  const { visible: bootVisible, publish } = useBootCard(continuesBootCard);
  const [pending, setPending] = useState<PendingMap>(NO_PENDING);
  const loads = useRef(createLoadSequence());
  const holdPending = (item: Pending) => setPending((current) => withPending(current, item));
  const releasePending = (item: Pending) => setPending((current) => withoutPending(current, item));
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [invite, setInvite] = useState<{ game: Game; world: World } | null>(null);
  const [creating, setCreating] = useState<{ game: Game; preset: Preset | null } | null>(null);
  const [editing, setEditing] = useState<{ game: Game; world: World } | null>(null);
  const [savingWorldSettings, setSavingWorldSettings] = useState(false);
  const [editingGameSettings, setEditingGameSettings] = useState<{ game: Game; world: World } | null>(null);
  const [savingGameSettings, setSavingGameSettings] = useState(false);

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
  const navItems = visibleNavigation(granted, capabilities)
    .map((item) => ({ id: item.id, label: item.label, href: scoped(item.id) }));
  const page: Page = route.page === "profile" || navItems.some((item) => item.id === route.page) ? route.page : "worlds";

  const directory = useAccessDirectory({ session, canRead: granted.has("access.read"), canManage: granted.has("access.manage"), notify });
  const viewer = viewerOf(session);
  const bootstrap = bootstrapOf(session);

  useEffect(() => initializeTelegram(), []);

  const refresh = useCallback(async (silent = false) => {
    const mine: Pending = { kind: "refresh" };
    if (!silent) setPending((current) => withPending(current, mine));
    setControlPlane((current) => (silent || current.snapshot ? { status: "loading", snapshot: current.snapshot, error: "" } : { status: "loading", snapshot: null, error: "" }));
    const ticket = loads.current.begin();
    try {
      const next = await api.loadControlPlane();
      if (loads.current.keep(ticket)) setControlPlane({ status: "ready", snapshot: next, error: "" });
    } catch (error) {
      if (loads.current.keep(ticket)) setControlPlane((current) => ({ status: "error", snapshot: current.snapshot, error: error instanceof Error ? error.message : t("common.controlPlaneStateCouldNot"), kind: failureKind(error) }));
    } finally {
      publish(() => setBooted(true));
      if (!silent) setPending((current) => withoutPending(current, mine));
    }
  }, [publish]);

  useEffect(() => { void refresh(true); }, [refresh]);

  const building = games.some((item) => item.presets.some((preset) => preset.buildStatus === "building"));
  useEffect(() => {
    if (!building) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh(true);
      if (!stopped) timer = setTimeout(() => void poll(), 5000);
    };
    timer = setTimeout(() => void poll(), 5000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [building, refresh]);

  // The browser painted from its own cache; the identity's choice outranks it.
  // A failure here is silent on purpose: a palette is not worth a banner.
  const { adopt } = appearance;
  useEffect(() => {
    let cancelled = false;
    api.loadAppearance().then((stored) => { if (!cancelled) adopt(stored); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [adopt]);

  // EventBridge updates the projection and the socket carries only an
  // invalidation. Permission-filtered state still comes from the HTTP API.
  useEffect(() => api.subscribeControlPlane(() => {
    const ticket = loads.current.begin();
    api.loadControlPlane().then((next) => { if (loads.current.keep(ticket)) setControlPlane({ status: "ready", snapshot: next, error: "" }); }).catch(() => undefined);
  }), []);

  // Keep the scope in the hash and remember it for the next visit.
  useEffect(() => {
    if (!game) return;
    setStoredGame(game.id);
    if (route.page !== "access" && route.page !== "profile" && route.gameId !== game.id) navigate({ gameId: game.id, worldId: route.worldId }, { replace: true });
  }, [game?.id, route.page, route.gameId]);

  async function runBuild(target: Game, preset: Preset) {
    const mine: Pending = { kind: "build", presetId: preset.id };
    holdPending(mine);
    try {
      const expected = releaseBuildExpectation(preset);
      const result = await api.requestReleaseBuild(target.id, preset.id, expected.profileDigest, expected.retryRelease);
      notify({ tone: "success", message: t("app.releaseReleaseBuildAttempt", { release: result.release, attempt: result.attempt }) });
      await refresh(true);
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : t("app.buildCouldNotRequested") });
      await refresh(true);
    } finally { releasePending(mine); }
  }

  async function runSession(target: Game, targetWorld: World, sessionAction: SessionAction, players?: StopPlayersPolicy) {
    const mine: Pending = { kind: "session", worldId: targetWorld.id, action: sessionAction };
    holdPending(mine);
    try {
      const result = await api.requestSessionOperation(target.id, targetWorld.id, sessionAction, players);
      notify({ tone: "success", message: sessionAcceptedMessage(targetWorld, sessionAction, result.result) });
      await refresh(true);
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : t("app.sessionActionRequestFailed", { sessionAction: operationNoun(sessionAction) }) });
    } finally {
      releasePending(mine);
    }
  }

  async function runLifecycle(target: Game, targetWorld: World, kind: WorldActionKind, backupKey?: string, release?: string) {
    const mine: Pending = { kind: "lifecycle", worldId: targetWorld.id, action: kind };
    holdPending(mine);
    try {
      await api.requestWorldLifecycle(target.id, targetWorld.id, kind === "wipe" ? "regenerate" : kind, backupKey, release);
      notify({ tone: "success", message: t("common.valueWorldDisplayNameAcceptedAppears", { value: capitalize(operationNoun(kind)), worldDisplayName: targetWorld.displayName }) });
      await refresh(true);
      if (kind === "purge") navigate({ page: "worlds", gameId: target.id, worldId: null });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : t("app.sessionActionRequestFailed", { sessionAction: operationNoun(kind) }) });
    } finally {
      releasePending(mine);
    }
  }

  async function runPromotion(target: Game, targetWorld: World, release: string) {
    const mine: Pending = { kind: "promote", worldId: targetWorld.id };
    holdPending(mine);
    try {
      const { result } = await api.requestPromotion(target.id, targetWorld.id, release);
      notify({ tone: "success", message: result === "switched"
        ? t("app.targetWorldDisplayNameWillStartRelease", { targetWorldDisplayName: targetWorld.displayName, release })
        : t("app.updateTargetWorldDisplayNameReleaseRelease", { targetWorldDisplayName: targetWorld.displayName, release }) });
      await refresh(true);
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : t("app.releaseUpdateRequestFailed") });
    } finally {
      releasePending(mine);
    }
  }

  async function runHostDeletion(host: Readonly<{ providerRef: string; name: string }>, snapshot: boolean) {
    try {
      await api.requestHostDeletion(host.providerRef, snapshot);
      notify({ tone: "success", message: snapshot ? t("host.deletingWithSnapshot", { hostName: host.name }) : t("host.deleting", { hostName: host.name }) });
      await refresh(true);
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : t("host.couldNotDelete") });
    }
  }

  async function downloadPack(target: Game, targetWorld: World) {
    const mine: Pending = { kind: "pack", worldId: targetWorld.id };
    holdPending(mine);
    try {
      const { release } = await openDownload(() => api.requestPackDownload(target.id, targetWorld.id));
      notify({ tone: "success", message: t("app.packReleaseReleaseDownloading", { release }) });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : t("app.packLinkFailed") });
    } finally {
      releasePending(mine);
    }
  }

  function downloadBackup(target: Game, targetWorld: World, entry: BackupEntry) {
    openDownload(() => api.requestBackupDownload(target.id, targetWorld.id, entry.key)).then(
      () => notify({ tone: "success", message: t("app.archiveNameDownloading", { archiveName: entry.archiveName }) }),
      (error: unknown) => notify({ tone: "error", message: error instanceof Error ? error.message : t("common.downloadLinkCouldNot") }),
    );
  }

  function downloadMod(target: Game, presetId: string, release: string, mod: ReleaseMod) {
    openDownload(() => api.requestModDownload(target.id, presetId, release, mod.sha256)).then(
      () => notify({ tone: "success", message: t("app.archiveNameDownloading", { archiveName: mod.file }) }),
      (error: unknown) => notify({ tone: "error", message: error instanceof Error ? error.message : t("common.downloadLinkCouldNot") }),
    );
  }

  function downloadReleasePack(target: Game, presetId: string, release: string, pack: ReleasePackName) {
    openDownload(() => api.requestReleasePack(target.id, presetId, release, pack)).then(
      () => notify({ tone: "success", message: t("app.packPackPresetIdRelease", { pack, presetId, release }) }),
      (error: unknown) => notify({ tone: "error", message: error instanceof Error ? error.message : t("common.downloadLinkCouldNot") }),
    );
  }

  async function saveGameSettings(target: Game, targetWorld: World, values: Readonly<Record<string, SettingValue>>) {
    setSavingGameSettings(true);
    try {
      await api.updateGameSettings(target.id, targetWorld.id, values);
      // The host reads them when a session starts; a running game is not touched.
      notify({ tone: "success", message: worldSessionActive(target, targetWorld)
        ? t("app.gameSettingsSavedTargetWorldDisplayName", { targetWorldDisplayName: targetWorld.displayName })
        : t("app.gameSettingsTargetWorldDisplayNameSaved", { targetWorldDisplayName: targetWorld.displayName }) });
      setEditingGameSettings(null);
      await refresh(true);
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : t("common.gameSettingsCouldNot") });
    } finally {
      setSavingGameSettings(false);
    }
  }

  async function createWorld(target: Game, preset: Preset, displayName: string, release: string, placement: WorldPlacement, connectivity: World["connectivity"], auth?: "game") {
    const mine: Pending = { kind: "create" };
    holdPending(mine);
    try {
      const created = await api.requestCreateWorld(target.id, preset.id, displayName, release, placement, connectivity, auth);
      notify({ tone: "success", message: t("app.createdDisplayNameWasCreatedFrom", { createdDisplayName: created.displayName, presetDisplayName: preset.displayName, release }) });
      setCreating(null);
      await refresh(true);
      navigate({ page: "worlds", gameId: target.id, worldId: created.id });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : t("common.worldCouldNotCreated") });
    } finally {
      releasePending(mine);
    }
  }

  async function saveWorldSettings(target: Game, targetWorld: World, placement: WorldPlacement, connectivity: World["connectivity"], auth?: "game", market?: WorldMarket) {
    setSavingWorldSettings(true);
    try {
      await api.requestUpdateWorldSettings(target.id, targetWorld.id, placement, connectivity, auth, market);
      notify({ tone: "success", message: t("app.connectionSettingsTargetWorldDisplayNameSaved", { targetWorldDisplayName: targetWorld.displayName }) });
      setEditing(null);
      await refresh(true);
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : t("common.worldSettingsCouldNot") });
    } finally {
      setSavingWorldSettings(false);
    }
  }

  const worldCallbacks: WorldCallbacks = {
    onWorldAction: (target, targetWorld, kind, backup) => {
      if (kind === "archive") setConfirmation({ kind: "archive", game: target, world: targetWorld });
      if (kind === "wipe") setConfirmation({ kind: "wipe", game: target, world: targetWorld, preset: target.presets.find((preset) => preset.id === (targetWorld.preset?.id ?? targetWorld.profileId)) ?? null });
      if (kind === "purge") setConfirmation({ kind: "purge", game: target, world: targetWorld });
      if (kind === "restore" && backup) setConfirmation({ kind: "restore", game: target, world: targetWorld, backupKey: backup.key, backupName: backup.name, release: backup.release });
    },
    onInvite: (target, targetWorld) => setInvite({ game: target, world: targetWorld }),
    onDownloadPack: (target, targetWorld) => void downloadPack(target, targetWorld),
    onEditSettings: (target, targetWorld) => setEditing({ game: target, world: targetWorld }),
    ...(capabilities.has("gameSettings") ? { onEditGameSettings: (target: Game, targetWorld: World) => setEditingGameSettings({ game: target, world: targetWorld }) } : {}),
    ...(capabilities.has("releasePromotion") ? { onPromote: (target: Game, targetWorld: World) => setConfirmation({ kind: "promote", game: target, world: targetWorld, preset: presetOf(target, targetWorld) ?? null }) } : {}),
  };

  const appearanceModel: AppearanceModel = {
    preference: appearance.preference,
    theme: appearance.theme,
    accent: appearance.accent,
    setPreference: appearance.setPreference,
    setAccent: appearance.setAccent,
  };

  // The assistant is an Owner's: assistant.use is reserved to the Owner role (ADR-0094, ADR-0096).
  const assistant = useAssistantChat(granted.has("assistant.use") && capabilities.has("assistant"), notify);

  const shell: ShellModel = {
    navigation: [...navItems, { id: "profile" as const, label: t("common.profile"), href: "#/profile" }].map((item): NavigationItem => ({ ...item, current: item.id === page })),
    page,
    scope: {
      game,
      games,
      statusOf: (item) => sessionStatus(deriveServerState(item, snapshot)),
      open: scopeOpen,
      show: action("scope.show", game?.displayName ?? t("app.noGame"), () => setScopeOpen(true), { disabled: games.length === 0, hint: t("common.selectGame") }),
      close: action("scope.close", t("common.cancel"), () => setScopeOpen(false)),
      select: (gameId) => { setScopeOpen(false); navigate({ gameId, worldId: null }); },
    },
    viewer,
    demo: session.demo === true,
    observedAt: snapshot ? formatDateTime(snapshot.observedAt) : undefined,
    openProfile: action("shell.profile", t("profile.openMyProfile"), () => navigate({ page: "profile" }), { hint: viewer.displayName }),
    overview: { id: "worlds", label: t("shell.home"), href: routeHash({ page: "worlds", accessTab: route.accessTab, gameId: game?.id ?? null, worldId: null, worldsView: "overview" }), current: page === "worlds" && !route.worldId && route.worldsView === "overview" },
    ...(snapshot ? { observedAtIso: snapshot.observedAt } : {}),
    requests: directory.requestCount,
    assistant,
  };

  const changeAvatar = async (file: File) => {
    setAvatarBusy(true);
    try {
      const prepared = await prepareAvatar(file, browserAvatarEnvironment);
      setPhotoUrl(await api.uploadAvatar(prepared.base64));
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : t("profile.pictureCouldNotSaved") });
    } finally {
      setAvatarBusy(false);
    }
  };
  const deleteAvatar = async () => {
    setAvatarBusy(true);
    try {
      await api.removeAvatar();
      setPhotoUrl(null);
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : t("profile.pictureCouldNotRemoved") });
    } finally {
      setAvatarBusy(false);
    }
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
    capabilities,
    snapshot,
    listStatus: listStatusOf(controlPlane),
    error: controlPlane.error,
    errorKind: controlPlane.status === "error" ? controlPlane.kind : "failed",
    games,
    game,
    world,
    fleet,
    fleetOverview,
    serverState,
    sharedSession,
    pending,
    refresh,
    refreshing: pendingOf(pending, "refresh") !== null,
    worldCallbacks,
    requestSession: (target, targetWorld, sessionAction) => setConfirmation({
      kind: "session", action: sessionAction, game: target, world: targetWorld,
      ...stopDisconnect(target, targetWorld, sessionAction, granted, sharedSession),
    }),
    requestCreateWorld: (target, preset) => setCreating({ game: target, preset: preset ?? target.presets.find((item) => startableReleases(item).length > 0) ?? null }),
    requestBuild: (target, preset) => setConfirmation({ kind: "build", game: target, preset }),
    requestHostDeletion: (host) => setConfirmation({ kind: "delete-host", host }),
    directory,
    bootstrap,
    appearance: appearanceModel,
    avatar: { busy: avatarBusy, change: (file) => void changeAvatar(file), remove: () => void deleteAvatar() },
    signOut: () => void endSession(api),
    openInBrowser: viewer.inTelegram ? openInBrowser : null,
    confirmation,
    closeConfirmation: () => setConfirmation(null),
    runConfirmation: (item, release, keep) => {
      setConfirmation(null);
      if (item.kind === "delete-host") { void runHostDeletion(item.host, keep ?? true); return; }
      if (item.kind === "build") void runBuild(item.game, item.preset);
      if (item.kind === "session") void runSession(item.game, item.world, item.action, item.disconnect === undefined ? undefined : "disconnect");
      if (item.kind === "archive") void runLifecycle(item.game, item.world, "archive");
      if (item.kind === "wipe") void runLifecycle(item.game, item.world, "wipe", undefined, release);
      if (item.kind === "restore") void runLifecycle(item.game, item.world, "restore", item.backupKey);
      if (item.kind === "purge") void runLifecycle(item.game, item.world, "purge");
      if (item.kind === "promote" && release) void runPromotion(item.game, item.world, release);
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
    editingGameSettings,
    closeEditingGameSettings: () => setEditingGameSettings(null),
    saveGameSettings,
    savingGameSettings,
    downloadBackup,
    downloadMod,
    downloadReleasePack,
    notify,
  };
}
