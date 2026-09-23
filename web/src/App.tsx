import { useCallback, useEffect, useMemo, useState } from "react";

import { ActiveSession, AuthState, endSession, loadAppearance, loadControlPlane, requestCreateWorld, requestPackDownload, requestSessionOperation, requestUpdateWorldSettings, requestWorldLifecycle, restoreAuth, subscribeControlPlane, updateAppearance } from "./auth";
import { InvitationSheet } from "./components/InvitationSheet";
import { Button } from "./components/ui/Button";
import { Dialog, Sheet } from "./components/ui/Dialog";
import { SelectField, TextField } from "./components/ui/Fields";
import { SnackbarProvider, useSnackbar } from "./components/ui/Snackbar";
import { sessionStatus } from "./components/ui/Status";
import { IconName } from "./icons";
import { formatDateTime, plural } from "./lib/format";
import { ControlPlaneSnapshot, Game, Member, OwnerBootstrap, Page, Preset, Role, ServerState, World } from "./model";
import { isLandingHash, isRootHash, readEmailActionRoute, routeHash } from "./routing";
import { deriveSharedHostSession } from "./session";
import { AccessScreen } from "./screens/AccessScreen";
import { AuthScreen, BootScreen } from "./screens/AuthScreen";
import { ConsoleScreen } from "./screens/ConsoleScreen";
import { EmailActionScreen } from "./screens/EmailActionScreen";
import { LandingScreen } from "./screens/LandingScreen";
import { MetricsScreen } from "./screens/MetricsScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { ReleasesScreen } from "./screens/ReleasesScreen";
import { WorldScreen } from "./screens/WorldScreen";
import { WorldsScreen } from "./screens/WorldsScreen";
import { Confirmation, Pending, SessionAction, WorldActionKind } from "./shell/actions";
import { AppBar } from "./shell/AppBar";
import { useBootCard, useMediaQuery, useRoute, useStoredState, useAppearance } from "./shell/hooks";
import { NavDrawer, NavItem } from "./shell/NavDrawer";
import { ScopeDialog } from "./shell/ScopeDialog";
import { initializeTelegram, ViewerProfile } from "./telegram";

// A screen is offered when the role may use it and the deployment routes it.
// `capability` is absent where a screen needs nothing from the API it does not
// already get from the control-plane snapshot.
const navigation: readonly { id: Page; label: string; icon: IconName; permission: string; capability?: string }[] = [
  { id: "worlds", label: "Worlds", icon: "public", permission: "status.read" },
  { id: "metrics", label: "Metrics", icon: "bar_chart", permission: "metrics.read" },
  { id: "console", label: "Console", icon: "terminal", permission: "console.use" },
  { id: "releases", label: "Releases", icon: "inventory", permission: "release.read" },
  { id: "access", label: "Access", icon: "group", permission: "access.read" },
];

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [atLanding, setAtLanding] = useState(() => isLandingHash());
  const { visible: bootVisible, publish } = useBootCard();
  const emailAction = readEmailActionRoute();

  useEffect(() => {
    let active = true;
    restoreAuth()
      .then((state) => publish(() => {
        if (!active) return;
        setAuth(state);
        // Arriving at the bare root with a session already in hand means the
        // console, not the front door: the Mini App opens that way every time,
        // and so does a browser that still holds its refresh cookie. The front
        // door keeps its own address at `#/welcome`.
        if (state.status === "authenticated" && state.session.state === "active" && isRootHash()) {
          window.history.replaceState(null, "", "#/worlds");
          setAtLanding(false);
        }
      }))
      .catch((error: unknown) => publish(() => {
        if (!active) return;
        setAuth({ status: "error", message: error instanceof Error ? error.message : "Sign-in failed." });
      }));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const onChange = () => setAtLanding(isLandingHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  // A sign-in started on the front door ends in the console; an account that
  // holds no role yet lands on the card that asks for one.
  const handleAuth = useCallback((state: AuthState) => {
    setAuth(state);
    if (state.status === "authenticated" && isLandingHash()) window.location.hash = "#/worlds";
  }, []);

  // The session is settled before anything else is drawn. Deciding later is what
  // made the front door appear first and then rearrange itself: a sign-in button
  // arriving from nowhere, or a jump into the console a beat after landing.
  if (emailAction !== null) return <EmailActionScreen action={emailAction} onAuth={handleAuth} />;
  if (auth.status === "loading") {
    return bootVisible ? <BootScreen description="Confirming who you are with the access API." title="Checking your session" /> : null;
  }
  if (atLanding) return <LandingScreen auth={auth} onChange={handleAuth} />;
  if (auth.status !== "authenticated") return <LandingScreen auth={auth} onChange={handleAuth} />;
  if (auth.session.state !== "active") return <AuthScreen auth={auth} onChange={handleAuth} />;
  return <SnackbarProvider><ConsoleShell continuesBootCard={bootVisible} session={auth.session} /></SnackbarProvider>;
}

type ControlPlaneState =
  | { status: "loading"; snapshot: ControlPlaneSnapshot | null; error: "" }
  | { status: "ready"; snapshot: ControlPlaneSnapshot; error: "" }
  | { status: "error"; snapshot: ControlPlaneSnapshot | null; error: string };

function ConsoleShell({ session, continuesBootCard }: { session: ActiveSession; continuesBootCard: boolean }) {
  const notify = useSnackbar();
  const [route, navigate] = useRoute();
  // The console only exists for a signed-in person, so every change here is
  // the account's to keep. The front door has no session and syncs nothing.
  const appearance = useAppearance({ sync: updateAppearance });
  const { theme, cycle: cycleTheme, label: themeLabel, adopt: adoptAppearance } = appearance;
  const mobile = useMediaQuery("(max-width: 959px)");
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The drawer collapses to an icon rail on narrow desktops until the person
  // chooses; a stored choice wins on every width above the phone breakpoint.
  const [railChoice, setRailChoice] = useStoredState<"true" | "false" | "auto">("spawnpoint.rail", "auto");
  const narrowDesktop = useMediaQuery("(min-width: 960px) and (max-width: 1199px)");
  const rail = railChoice === "auto" ? narrowDesktop : railChoice === "true";
  const [storedGame, setStoredGame] = useStoredState<string>("spawnpoint.scope", "");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [controlPlane, setControlPlane] = useState<ControlPlaneState>({ status: "loading", snapshot: null, error: "" });
  const [booted, setBooted] = useState(false);
  const { visible: shellBootVisible, publish: publishShell } = useBootCard(continuesBootCard);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [invite, setInvite] = useState<{ game: Game; world: World } | null>(null);
  const [creating, setCreating] = useState<{ game: Game; preset: Preset | null } | null>(null);
  const [editingWorld, setEditingWorld] = useState<{ game: Game; world: World } | null>(null);
  const [savingWorldSettings, setSavingWorldSettings] = useState(false);

  const granted = useMemo(() => new Set([...(session.role?.permissions ?? []), ...session.identity.directGrants]), [session]);
  const snapshot = controlPlane.snapshot;
  const games = snapshot?.games ?? [];
  const game = games.find((item) => item.id === route.gameId) ?? games.find((item) => item.id === storedGame) ?? games[0];
  const world = route.page === "worlds" && route.worldId ? game?.worlds.find((item) => item.id === route.worldId) : undefined;
  const fleet = world?.placement === "fleet";
  const fleetOverview = game?.worlds.find((item) => item.id === game.lifecycle?.activeWorldId)?.placement === "fleet" || (!game?.lifecycle?.activeSessionId && game?.worlds.some((item) => item.placement === "fleet"));
  const serverState = deriveServerState(game, snapshot);
  const sharedSession = deriveSharedHostSession(snapshot);
  const scoped = (page: Page) => routeHash({ page, accessTab: route.accessTab, gameId: game?.id ?? null, worldId: null });
  const capabilities = useMemo(() => new Set(session.capabilities), [session]);
  const navItems: NavItem[] = navigation
    .filter((item) => granted.has(item.permission) && (item.capability === undefined || capabilities.has(item.capability)))
    .map((item) => ({ id: item.id, label: item.label, icon: item.icon, href: scoped(item.id) }));
  const page: Page = route.page === "profile" || navItems.some((item) => item.id === route.page) ? route.page : "worlds";

  const [members, setMembers] = useState<Member[]>(() => [{
    id: session.identity.id,
    name: session.identity.displayName,
    roleId: session.identity.roleId,
    links: [],
  }]);
  const [roles, setRoles] = useState<Role[]>(() => session.role ? [{ id: session.role.id, name: session.role.name, description: "Current signed-in role", permissions: session.role.permissions, system: true }] : []);
  const viewer: ViewerProfile = {
    displayName: session.identity.displayName,
    inTelegram: Boolean(window.Telegram?.WebApp.initData),
    provider: session.profile.provider,
    ...(session.profile.username ? { username: session.profile.username } : {}),
    ...(session.profile.email ? { email: session.profile.email } : {}),
    ...(session.profile.photoUrl ? { photoUrl: session.profile.photoUrl } : {}),
    ...(session.profile.telegramId ? { telegramId: session.profile.telegramId } : {}),
  };
  const currentMember = members.find((member) => member.id === session.identity.id) ?? members[0]!;
  const bootstrap: OwnerBootstrap = session.bootstrap.state === "claimed"
    ? { state: "claimed", telegramId: session.bootstrap.telegramId, ownerId: session.bootstrap.ownerId, claimedAt: formatDateTime(session.bootstrap.claimedAt) }
    : { state: "unclaimed", telegramId: session.profile.telegramId };

  useEffect(() => initializeTelegram(), []);

  async function refresh(silent = false) {
    if (!silent) setPending({ kind: "refresh" });
    setControlPlane((current) => (silent || current.snapshot ? { status: "loading", snapshot: current.snapshot, error: "" } : { status: "loading", snapshot: null, error: "" }));
    try {
      const next = await loadControlPlane();
      setControlPlane({ status: "ready", snapshot: next, error: "" });
    } catch (error) {
      setControlPlane((current) => ({ status: "error", snapshot: current.snapshot, error: error instanceof Error ? error.message : "The control-plane state could not be loaded." }));
    } finally {
      publishShell(() => setBooted(true));
      if (!silent) setPending((current) => (current?.kind === "refresh" ? null : current));
    }
  }

  useEffect(() => { void refresh(true); }, []);

  // The browser painted from its own cache; the identity's choice outranks it.
  // A failure here is silent on purpose: a palette is not worth a banner.
  useEffect(() => {
    let cancelled = false;
    loadAppearance()
      .then((stored) => { if (!cancelled) adoptAppearance(stored); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [adoptAppearance]);

  // EventBridge updates the projection and the socket carries only an
  // invalidation. Permission-filtered state still comes from the HTTP API.
  useEffect(() => {
    return subscribeControlPlane(() => {
      loadControlPlane().then((next) => setControlPlane({ status: "ready", snapshot: next, error: "" })).catch(() => undefined);
    });
  }, []);

  // Keep the scope in the hash and remember it for the next visit.
  useEffect(() => {
    if (!game) return;
    setStoredGame(game.id);
    if (route.page !== "access" && route.page !== "profile" && route.gameId !== game.id) navigate({ gameId: game.id, worldId: route.worldId }, { replace: true });
  }, [game?.id, route.page, route.gameId]);

  useEffect(() => { setDrawerOpen(false); }, [route.page, route.worldId, route.gameId, mobile]);
  // Escape closes what overlays the page, the drawer included.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawerOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  function selectGame(gameId: string) {
    setScopeOpen(false);
    navigate({ gameId, worldId: null });
  }

  function requestSession(target: Game, targetWorld: World, action: SessionAction) {
    setConfirmation({ kind: "session", action, game: target, world: targetWorld });
  }

  function requestWorldAction(target: Game, targetWorld: World, action: WorldActionKind, backup?: { key: string; name: string }) {
    if (action === "archive") setConfirmation({ kind: "archive", game: target, world: targetWorld });
    if (action === "wipe") setConfirmation({ kind: "wipe", game: target, world: targetWorld, preset: target.presets.find((preset) => preset.id === (targetWorld.preset?.id ?? targetWorld.profileId)) ?? null });
    if (action === "purge") setConfirmation({ kind: "purge", game: target, world: targetWorld });
    if (action === "restore" && backup) setConfirmation({ kind: "restore", game: target, world: targetWorld, backupKey: backup.key, backupName: backup.name });
  }

  async function runSession(target: Game, targetWorld: World, action: SessionAction) {
    setPending({ kind: "session", worldId: targetWorld.id, action });
    try {
      const result = await requestSessionOperation(target.id, targetWorld.id, action);
      notify({ tone: "success", message: result.result === "already_stopped" ? "The host is already stopped." : `${action === "start" ? "Start" : "Stop"} of ${targetWorld.displayName} accepted. It appears in Operations while it runs.` });
      await refresh(true);
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : `The ${action} request failed.` });
    } finally {
      setPending(null);
    }
  }

  async function runLifecycle(target: Game, targetWorld: World, action: WorldActionKind, backupKey?: string, release?: string) {
    setPending({ kind: "lifecycle", worldId: targetWorld.id, action });
    try {
      const result = await requestWorldLifecycle(target.id, targetWorld.id, action === "wipe" ? "regenerate" : action, backupKey, release);
      notify({ tone: "success", message: `${lifecycleLabel(action)} of ${targetWorld.displayName} accepted. It appears in Operations while it runs.` });
      await refresh(true);
      if (action === "purge") navigate({ page: "worlds", gameId: target.id, worldId: null });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : `The ${action} request failed.` });
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
      if (downloadWindow !== null) downloadWindow.location.replace(url);
      else window.location.assign(url);
      notify({ tone: "success", message: `Pack for release ${release} is downloading.` });
    } catch (error) {
      downloadWindow?.close();
      notify({ tone: "error", message: error instanceof Error ? error.message : "The pack link failed." });
    } finally {
      setPending(null);
    }
  }

  async function createWorld(target: Game, preset: Preset, displayName: string, release: string, placement: "configured" | "fleet", connectivity: World["connectivity"], auth?: "game") {
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

  async function saveWorldSettings(target: Game, targetWorld: World, placement: "configured" | "fleet", connectivity: World["connectivity"], auth?: "game") {
    setSavingWorldSettings(true);
    try {
      await requestUpdateWorldSettings(target.id, targetWorld.id, placement, connectivity, auth);
      notify({ tone: "success", message: `Connection settings for ${targetWorld.displayName} saved.` });
      setEditingWorld(null);
      await refresh(true);
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "World settings could not be saved." });
    } finally {
      setSavingWorldSettings(false);
    }
  }

  if (!booted) return shellBootVisible ? <BootScreen description="Reading games, worlds and the current AWS state." title="Preparing the console" /> : null;

  const listStatus = controlPlane.status === "loading" && controlPlane.snapshot === null ? "loading" : controlPlane.status === "error" ? "error" : "ready";

  return (
    <div className="shell" data-drawer-open={mobile && drawerOpen ? "true" : undefined} data-rail={!mobile && rail ? "true" : undefined}>
      <AppBar
        game={game}
        onMenu={() => (mobile ? setDrawerOpen((open) => !open) : setRailChoice(rail ? "false" : "true"))}
        onProfile={() => navigate({ page: "profile" })}
        onScope={() => setScopeOpen(true)}
        onTheme={cycleTheme}
        demo={session.demo === true}
        scopeDisabled={games.length === 0}
        theme={theme}
        themeLabel={themeLabel}
        viewerName={viewer.displayName}
        viewerPhoto={viewer.photoUrl}
      />
      <div className="shell-body">
        <NavDrawer
          current={page}
          footer={snapshot ? { label: "Control plane observed", value: formatDateTime(snapshot.observedAt) } : undefined}
          items={[...navItems, { id: "profile", label: "Profile", icon: "person", href: "#/profile" }]}
          onNavigate={() => setDrawerOpen(false)}
        />
        {/* Pointer-down, not click: a tap that moves a hair produces no click at
            all, so the drawer ignored half the taps meant to dismiss it. */}
        <div aria-hidden="true" className="drawer-scrim" onPointerDown={() => setDrawerOpen(false)} />
        <main className="main" id="main">
          {page === "worlds" && game && world && <WorldScreen fleet={fleet} game={game} granted={granted} onEditSettings={(target, targetWorld) => setEditingWorld({ game: target, world: targetWorld })} onTabChange={(worldTab) => navigate({ worldTab })} onDownloadPack={(target, targetWorld) => void downloadPack(target, targetWorld)} onInvite={(target, targetWorld) => setInvite({ game: target, world: targetWorld })} onRefresh={() => void refresh()} onSessionAction={requestSession} onWorldAction={requestWorldAction} pending={pending} serverState={serverState} sharedSession={sharedSession} snapshot={snapshot} tab={route.worldTab} world={world} />}
          {page === "worlds" && !(game && world) && <WorldsScreen error={controlPlane.error} fleet={Boolean(fleetOverview)} game={game} granted={granted} onCreateWorld={(target) => setCreating({ game: target, preset: target.presets.find((preset) => preset.buildStatus === "ready") ?? null })} onDownloadPack={(target, targetWorld) => void downloadPack(target, targetWorld)} onInvite={(target, targetWorld) => setInvite({ game: target, world: targetWorld })} onRefresh={() => void refresh()} onWorldAction={requestWorldAction} pending={pending} serverState={serverState} sharedSession={sharedSession} snapshot={snapshot} status={listStatus} />}
          {page === "metrics" && <MetricsScreen game={game} serverState={serverState} snapshot={snapshot} />}
          {page === "console" && <ConsoleScreen game={game} serverState={serverState} />}
          {page === "releases" && <ReleasesScreen game={game} granted={granted} loading={listStatus === "loading"} onCreateWorld={(target, preset) => setCreating({ game: target, preset })} pending={pending} />}
          {page === "access" && <AccessScreen bootstrap={bootstrap} games={games} members={members} onMembersChange={setMembers} onRolesChange={setRoles} onTabChange={(tab) => navigate({ page: "access", accessTab: tab })} roles={roles} tab={route.accessTab} />}
          {page === "profile" && <ProfileScreen appearance={appearance} member={currentMember} onSignOut={endSession} role={roles.find((role) => role.id === currentMember.roleId)} viewer={viewer} />}
        </main>
      </div>

      <ScopeDialog currentId={game?.id ?? null} games={games} onClose={() => setScopeOpen(false)} onSelect={selectGame} open={scopeOpen} statusOf={(item) => sessionStatus(deriveServerState(item, snapshot))} />
      {invite && <InvitationSheet game={invite.game} onClose={() => setInvite(null)} open world={invite.world} />}
      {creating && <CreateWorldSheet busy={pending?.kind === "create"} deployment={snapshot?.deployment} game={creating.game} initialPreset={creating.preset} onClose={() => setCreating(null)} onCreate={(preset, name, release, placement, connectivity, auth) => void createWorld(creating.game, preset, name, release, placement, connectivity, auth)} />}
      {editingWorld && <WorldSettingsSheet busy={savingWorldSettings} deployment={snapshot?.deployment} game={editingWorld.game} onClose={() => setEditingWorld(null)} onSave={(placement, connectivity, auth) => void saveWorldSettings(editingWorld.game, editingWorld.world, placement, connectivity, auth)} world={editingWorld.world} />}
      <ConfirmationDialog
        confirmation={confirmation}
        onClose={() => setConfirmation(null)}
        onConfirm={(item, extra) => {
          setConfirmation(null);
          if (item.kind === "session") void runSession(item.game, item.world, item.action);
          if (item.kind === "archive") void runLifecycle(item.game, item.world, "archive");
          if (item.kind === "wipe") void runLifecycle(item.game, item.world, "wipe", undefined, extra);
          if (item.kind === "restore") void runLifecycle(item.game, item.world, "restore", item.backupKey);
          if (item.kind === "purge") void runLifecycle(item.game, item.world, "purge");
        }}
      />
    </div>
  );
}

function ConfirmationDialog({ confirmation, onClose, onConfirm }: { confirmation: Confirmation | null; onClose: () => void; onConfirm: (confirmation: Confirmation, extra?: string) => void }) {
  const [typed, setTyped] = useState("");
  const [release, setRelease] = useState("");
  useEffect(() => {
    setTyped("");
    setRelease(confirmation?.kind === "wipe" ? confirmation.preset?.latestRelease ?? "" : "");
  }, [confirmation]);
  if (confirmation === null) return <Dialog onClose={onClose} open={false} title="" />;

  const { world, game } = confirmation;
  const title = confirmation.kind === "session"
    ? confirmation.action === "start" ? "Start a billed AWS session?" : "Save, back up and stop this session?"
    : confirmation.kind === "archive" ? `Archive ${world.displayName}?`
      : confirmation.kind === "wipe" ? `Start a new wipe of ${world.displayName}?`
        : confirmation.kind === "purge" ? `Permanently delete ${world.displayName}?`
          : `Restore ${confirmation.backupName}?`;
  const description = confirmation.kind === "session"
    ? confirmation.action === "start"
      ? world.materialization === "not_created"
        ? `Spawnpoint will create ${world.displayName} from its ready preset, open wipe #1 and boot the shared host for ${game.displayName}. The first start may take several minutes, and the host is billed while it runs.`
        : `Spawnpoint will boot the shared host and start ${world.displayName}. ${game.displayName} may take several minutes to become healthy, and the host is billed while it runs.`
      : "Spawnpoint refuses while players are online, then saves the world, takes a verified backup and stops the host."
    : confirmation.kind === "archive"
      ? "Spawnpoint will safely stop and back up an active session, then hide this world from session control. Its wipes and backups stay intact."
      : confirmation.kind === "wipe"
        ? `Spawnpoint will safely stop and back up the current wipe, close it, and open an empty wipe from the selected ${confirmation.preset?.displayName ?? "preset"} release.`
        : confirmation.kind === "purge"
          ? "This deletes the world registry, the release pointer and every version of every S3 backup. It cannot be undone from the console."
          : `Spawnpoint will safely stop and back up the current wipe, then restore ${confirmation.backupName} as a new wipe.`;
  const destructive = confirmation.kind === "purge" || confirmation.kind === "wipe" || confirmation.kind === "restore" || (confirmation.kind === "session" && confirmation.action === "stop");
  const confirmLabel = confirmation.kind === "session" ? (confirmation.action === "start" ? "Start session" : "Stop session") : confirmation.kind === "archive" ? "Archive world" : confirmation.kind === "wipe" ? "Start new wipe" : confirmation.kind === "purge" ? "Delete forever" : "Restore backup";
  const blocked = (confirmation.kind === "purge" && typed !== world.id) || (confirmation.kind === "wipe" && !(confirmation.preset?.releases.includes(release) ?? false));

  return (
    <Dialog
      actions={<>
        <Button onClick={onClose} variant="text">Cancel</Button>
        <Button disabled={blocked} onClick={() => onConfirm(confirmation, confirmation.kind === "wipe" ? release : undefined)} variant={destructive ? "danger" : "filled"}>{confirmLabel}</Button>
      </>}
      dismissOnBackdrop={false}
      onClose={onClose}
      open
      title={title}
    >
      <p>{description}</p>
      {confirmation.kind === "wipe" && confirmation.preset && (
        <SelectField label="Release for the new wipe" onChange={(event) => setRelease(event.target.value)} value={release}>
          <option disabled value="">Choose a release</option>
          {[...confirmation.preset.releases].reverse().map((version) => <option key={version} value={version}>{version}{version === confirmation.preset?.latestRelease ? " (latest)" : ""}</option>)}
        </SelectField>
      )}
      {confirmation.kind === "purge" && <>
        <p className="confirm-note">Type <code>{world.id}</code> to confirm.</p>
        <TextField autoComplete="off" data-autofocus label="World ID" mono onChange={(event) => setTyped(event.target.value)} placeholder={world.id} value={typed} />
      </>}
    </Dialog>
  );
}

type WorldPlacement = "configured" | "fleet";

function WorldConnectionFields({ deployment, placement, connectivity, onPlacement, onConnectivity }: Readonly<{
  deployment: ControlPlaneSnapshot["deployment"];
  placement: WorldPlacement;
  connectivity: World["connectivity"];
  onPlacement: (placement: WorldPlacement) => void;
  onConnectivity: (connectivity: World["connectivity"]) => void;
}>) {
  const fleetAvailable = deployment?.launchEnabled === true;
  return <>
    <SelectField label="Hosting" hint="Choose where this world's server starts." onChange={(event) => {
      const next = event.target.value as WorldPlacement;
      onPlacement(next);
      onConnectivity(next === "fleet" ? (deployment?.dnsAvailable ? "route53" : "raw") : "zerotier");
    }} value={placement}>
      <option value="configured">Persistent host · ZeroTier</option>
      <option disabled={!fleetAvailable} value="fleet">On-demand fleet · public connection{fleetAvailable ? "" : " (not configured)"}</option>
    </SelectField>
    {placement === "fleet" && <SelectField label="Connection" hint="Fleet machines are disposable and never join ZeroTier." onChange={(event) => onConnectivity(event.target.value as World["connectivity"])} value={connectivity}>
      <option value="raw">Public IP and game port</option>
      {deployment?.dnsAvailable && <option value="route53">Public DNS</option>}
    </SelectField>}
    {placement === "fleet" && <p className="secondary">The game port is public. Set the game's password or allowlist yourself before sharing its address.</p>}
  </>;
}

function CreateWorldSheet({ game, initialPreset, deployment, busy, onClose, onCreate }: { game: Game; initialPreset: Preset | null; deployment: ControlPlaneSnapshot["deployment"]; busy: boolean; onClose: () => void; onCreate: (preset: Preset, name: string, release: string, placement: WorldPlacement, connectivity: World["connectivity"], auth?: "game") => void }) {
  const readyPresets = game.presets.filter((preset) => preset.buildStatus === "ready");
  const [placement, setPlacement] = useState<WorldPlacement>(deployment?.placement === "fleet" && deployment.launchEnabled ? "fleet" : "configured");
  const [presetId, setPresetId] = useState(initialPreset?.id ?? readyPresets[0]?.id ?? "");
  const preset = game.presets.find((item) => item.id === presetId) ?? null;
  const [name, setName] = useState("");
  const [release, setRelease] = useState(preset?.latestRelease ?? "");
  const [connectivity, setConnectivity] = useState<World["connectivity"]>(placement === "fleet" ? (deployment?.dnsAvailable ? "route53" : "raw") : "zerotier");
  useEffect(() => setRelease(preset?.latestRelease ?? ""), [preset?.id, preset?.latestRelease]);
  const networkValid = placement === "fleet" ? deployment?.launchEnabled && (connectivity === "raw" || (connectivity === "route53" && deployment?.dnsAvailable)) : connectivity === "zerotier";
  const valid = preset !== null && preset.buildStatus === "ready" && preset.releases.includes(release) && name.trim().length > 0 && name.trim().length <= 80 && networkValid;
  const submit = () => { if (preset && valid) onCreate(preset, name.trim(), release, placement, connectivity, connectivity === "zerotier" ? undefined : "game"); };

  return (
    <Sheet
      description={`A new world opens wipe #1 from an immutable ${game.displayName} release.`}
      footer={<>
        <p>{preset ? `${preset.displayName} · ${plural(preset.releases.length, "release")}` : "Choose a preset"}</p>
        <Button disabled={!valid || busy} icon="add" loading={busy} onClick={submit} variant="filled">Create world</Button>
      </>}
      onClose={onClose}
      open
      title="Create world"
    >
      <form className="page" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <SelectField hint={readyPresets.length === 0 ? "No preset of this game has a ready release." : undefined} label="Preset" onChange={(event) => setPresetId(event.target.value)} value={presetId}>
          {game.presets.map((item) => <option disabled={item.buildStatus !== "ready"} key={item.id} value={item.id}>{item.displayName}{item.buildStatus !== "ready" ? ` (${item.buildStatus})` : ""}</option>)}
        </SelectField>
        <TextField autoComplete="off" data-autofocus hint="1 to 80 characters. Shown in the worlds list and in Telegram." label="Name" maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="For example, Rail world" value={name} />
        <SelectField disabled={!preset} label="Release" onChange={(event) => setRelease(event.target.value)} value={release}>
          <option disabled value="">Choose a release</option>
          {preset && [...preset.releases].reverse().map((version) => <option key={version} value={version}>{version}{version === preset.latestRelease ? " (latest)" : ""}</option>)}
        </SelectField>
        <WorldConnectionFields connectivity={connectivity} deployment={deployment} onConnectivity={setConnectivity} onPlacement={setPlacement} placement={placement} />
      </form>
    </Sheet>
  );
}

function WorldSettingsSheet({ game, world, deployment, busy, onClose, onSave }: Readonly<{
  game: Game;
  world: World;
  deployment: ControlPlaneSnapshot["deployment"];
  busy: boolean;
  onClose: () => void;
  onSave: (placement: WorldPlacement, connectivity: World["connectivity"], auth?: "game") => void;
}>) {
  const [placement, setPlacement] = useState<WorldPlacement>(world.placement ?? (world.connectivity === "zerotier" ? "configured" : "fleet"));
  const [connectivity, setConnectivity] = useState<World["connectivity"]>(world.connectivity);
  const valid = placement === "configured" ? connectivity === "zerotier" : deployment?.launchEnabled && (connectivity === "raw" || (connectivity === "route53" && deployment.dnsAvailable));
  const stopped = game.lifecycle === null || (game.lifecycle.activeSessionId === null && game.lifecycle.observedState === "stopped");
  return <Sheet
    description={`Choose how ${world.displayName} is hosted and reached. Changes are allowed only while the world is stopped.`}
    footer={<><Button disabled={busy} onClick={onClose} variant="text">Cancel</Button><Button disabled={!valid || !stopped || busy} loading={busy} onClick={() => onSave(placement, connectivity, connectivity === "zerotier" ? undefined : "game")} variant="filled">Save settings</Button></>}
    onClose={onClose}
    open
    title={`Hosting · ${game.displayName}`}
  >
    {!stopped && <p className="secondary">Stop this game's current session before changing hosting.</p>}
    <WorldConnectionFields connectivity={connectivity} deployment={deployment} onConnectivity={setConnectivity} onPlacement={setPlacement} placement={placement} />
  </Sheet>;
}

function lifecycleLabel(action: WorldActionKind): string {
  return action === "wipe" ? "New wipe" : action === "archive" ? "Archive" : action === "restore" ? "Restore" : "Delete";
}

function deriveServerState(game: Game | undefined, snapshot: ControlPlaneSnapshot | null): ServerState {
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
  if (hostStates.some((state) => state === "pending")) return "starting";
  if (hostStates.some((state) => state === "stopping")) return "stopping";
  if (hostStates.some((state) => state === "running")) return "unknown";
  return hostStates.length > 0 ? "stopped" : "unknown";
}
