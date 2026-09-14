import { useCallback, useEffect, useMemo, useState } from "react";

import { ActiveSession, AuthState, endSession, loadControlPlane, requestCreateWorld, requestPackDownload, requestSessionOperation, requestWorldLifecycle, restoreAuth } from "./auth";
import { InvitationSheet } from "./components/InvitationSheet";
import { Button } from "./components/ui/Button";
import { Dialog, Sheet } from "./components/ui/Dialog";
import { SelectField, TextField } from "./components/ui/Fields";
import { SnackbarProvider, useSnackbar } from "./components/ui/Snackbar";
import { sessionStatus } from "./components/ui/Status";
import { demoEnabled, leaveDemo, resetDemo } from "./demo";
import { IconName } from "./icons";
import { formatDateTime } from "./lib/format";
import { ControlPlaneSnapshot, Game, Member, OwnerBootstrap, Page, Preset, Role, ServerState, World } from "./model";
import { isLandingHash, isRootHash, routeHash } from "./routing";
import { deriveSharedHostSession } from "./session";
import { AccessScreen } from "./screens/AccessScreen";
import { AuthScreen, BootScreen } from "./screens/AuthScreen";
import { ConsoleScreen } from "./screens/ConsoleScreen";
import { LandingScreen } from "./screens/LandingScreen";
import { MetricsScreen } from "./screens/MetricsScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { ReleasesScreen } from "./screens/ReleasesScreen";
import { WorldScreen } from "./screens/WorldScreen";
import { WorldsScreen } from "./screens/WorldsScreen";
import { Confirmation, Pending, SessionAction, WorldActionKind } from "./shell/actions";
import { AppBar } from "./shell/AppBar";
import { useMediaQuery, useRoute, useStoredState, useTheme } from "./shell/hooks";
import { NavDrawer, NavItem } from "./shell/NavDrawer";
import { ScopeDialog } from "./shell/ScopeDialog";
import { initializeTelegram, ViewerProfile } from "./telegram";

const navigation: readonly { id: Page; label: string; icon: IconName; permission: string }[] = [
  { id: "worlds", label: "Worlds", icon: "public", permission: "status.read" },
  { id: "metrics", label: "Metrics", icon: "bar_chart", permission: "metrics.read" },
  { id: "console", label: "Console", icon: "terminal", permission: "console.use" },
  { id: "releases", label: "Releases", icon: "inventory", permission: "release.read" },
  { id: "access", label: "Access", icon: "group", permission: "access.read" },
];

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [atLanding, setAtLanding] = useState(() => isLandingHash());

  useEffect(() => {
    let active = true;
    restoreAuth()
      .then((state) => {
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
      })
      .catch((error: unknown) => { if (active) setAuth({ status: "error", message: error instanceof Error ? error.message : "Sign-in failed." }); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const onChange = () => setAtLanding(isLandingHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  // A sign-in started on the front door ends in the console.
  const handleAuth = useCallback((state: AuthState) => {
    setAuth(state);
    if (state.status === "authenticated" && state.session.state === "active" && isLandingHash()) window.location.hash = "#/worlds";
  }, []);

  if (atLanding) return <LandingScreen auth={auth} onChange={handleAuth} />;
  if (auth.status === "loading") return <BootScreen description="Verifying your Telegram sign-in with the access API." title="Checking your session" />;
  if (auth.status !== "authenticated") return <LandingScreen auth={auth} onChange={handleAuth} />;
  if (auth.session.state !== "active") return <AuthScreen auth={auth} onChange={handleAuth} />;
  return <SnackbarProvider><ConsoleShell session={auth.session} /></SnackbarProvider>;
}

type ControlPlaneState =
  | { status: "loading"; snapshot: ControlPlaneSnapshot | null; error: "" }
  | { status: "ready"; snapshot: ControlPlaneSnapshot; error: "" }
  | { status: "error"; snapshot: ControlPlaneSnapshot | null; error: string };

function ConsoleShell({ session }: { session: ActiveSession }) {
  const notify = useSnackbar();
  const [route, navigate] = useRoute();
  const { theme, cycle: cycleTheme, label: themeLabel } = useTheme();
  const mobile = useMediaQuery("(max-width: 959px)");
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The drawer collapses to an icon rail on narrow desktops until the person
  // chooses; a stored choice wins on every width above the phone breakpoint.
  const [railChoice, setRailChoice] = useStoredState<"true" | "false" | "auto">("spawnpoint.rail", "auto");
  const narrowDesktop = useMediaQuery("(min-width: 960px) and (max-width: 1279px)");
  const rail = railChoice === "auto" ? narrowDesktop : railChoice === "true";
  const [storedGame, setStoredGame] = useStoredState<string>("spawnpoint.scope", "");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [controlPlane, setControlPlane] = useState<ControlPlaneState>({ status: "loading", snapshot: null, error: "" });
  const [booted, setBooted] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [invite, setInvite] = useState<{ game: Game; world: World } | null>(null);
  const [creating, setCreating] = useState<{ game: Game; preset: Preset | null } | null>(null);

  const granted = useMemo(() => new Set([...(session.role?.permissions ?? []), ...session.identity.directGrants]), [session]);
  const snapshot = controlPlane.snapshot;
  const games = snapshot?.games ?? [];
  const game = games.find((item) => item.id === route.gameId) ?? games.find((item) => item.id === storedGame) ?? games[0];
  const world = route.page === "worlds" && route.worldId ? game?.worlds.find((item) => item.id === route.worldId) : undefined;
  const serverState = deriveServerState(game, snapshot);
  const sharedSession = deriveSharedHostSession(snapshot);
  const scoped = (page: Page) => routeHash({ page, accessTab: route.accessTab, gameId: game?.id ?? null, worldId: null });
  const navItems: NavItem[] = navigation.filter((item) => granted.has(item.permission)).map((item) => ({ id: item.id, label: item.label, icon: item.icon, href: scoped(item.id) }));
  const page: Page = route.page === "profile" || navItems.some((item) => item.id === route.page) ? route.page : "worlds";

  const [members, setMembers] = useState<Member[]>(() => [{
    id: session.identity.id,
    name: session.identity.displayName,
    roleId: session.identity.roleId,
    links: [{ id: "viewer-telegram", kind: "telegram", value: session.profile.telegramId, verified: true }],
  }]);
  const [roles, setRoles] = useState<Role[]>(() => session.role ? [{ id: session.role.id, name: session.role.name, description: "Current signed-in role", permissions: session.role.permissions, system: true }] : []);
  const viewer: ViewerProfile = {
    displayName: session.identity.displayName,
    inTelegram: Boolean(window.Telegram?.WebApp.initData),
    ...(session.profile.username ? { username: session.profile.username } : {}),
    ...(session.profile.photoUrl ? { photoUrl: session.profile.photoUrl } : {}),
    telegramId: session.profile.telegramId,
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
      setBooted(true);
      if (!silent) setPending((current) => (current?.kind === "refresh" ? null : current));
    }
  }

  useEffect(() => { void refresh(true); }, []);

  // Poll while an operation runs, so the table and the state settle on their own.
  useEffect(() => {
    if (!snapshot?.operations.length) return;
    const timer = window.setInterval(() => {
      loadControlPlane().then((next) => setControlPlane({ status: "ready", snapshot: next, error: "" })).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [snapshot?.operations.length]);

  // Keep the scope in the hash and remember it for the next visit.
  useEffect(() => {
    if (!game) return;
    setStoredGame(game.id);
    if (route.page !== "access" && route.page !== "profile" && route.gameId !== game.id) navigate({ gameId: game.id, worldId: route.worldId }, { replace: true });
  }, [game?.id, route.page, route.gameId]);

  useEffect(() => { setDrawerOpen(false); }, [route.page, route.worldId, route.gameId, mobile]);

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
      notify({ tone: "success", message: result.result === "already_stopped" ? "The host is already stopped." : `${action === "start" ? "Start" : "Stop"} of ${targetWorld.displayName} accepted${result.operationId ? ` · ${result.operationId}` : ""}.` });
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
      notify({ tone: "success", message: `${lifecycleLabel(action)} of ${targetWorld.displayName} accepted · ${result.operationId}.` });
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

  async function createWorld(target: Game, preset: Preset, displayName: string, release: string) {
    setPending({ kind: "create" });
    try {
      const created = await requestCreateWorld(target.id, preset.id, displayName, release);
      notify({ tone: "success", message: `${created.displayName} was created from ${preset.displayName} ${release}.` });
      setCreating(null);
      await refresh(true);
      navigate({ page: "worlds", gameId: target.id, worldId: created.id });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "The save could not be created." });
    } finally {
      setPending(null);
    }
  }

  if (!booted) return <BootScreen description="Reading games, worlds and the current AWS state." title="Preparing the console" />;

  const listStatus = controlPlane.status === "loading" && controlPlane.snapshot === null ? "loading" : controlPlane.status === "error" ? "error" : "ready";

  return (
    <div className="shell" data-drawer-open={mobile && drawerOpen ? "true" : undefined} data-rail={!mobile && rail ? "true" : undefined}>
      <AppBar
        game={game}
        onMenu={() => (mobile ? setDrawerOpen((open) => !open) : setRailChoice(rail ? "false" : "true"))}
        onProfile={() => navigate({ page: "profile" })}
        onScope={() => setScopeOpen(true)}
        onTheme={cycleTheme}
        demo={demoEnabled}
        onDemoLeave={leaveDemo}
        onDemoReset={() => { resetDemo(); void refresh(true); notify({ tone: "info", message: "The demo is back at its starting state." }); }}
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
        <div aria-hidden="true" className="drawer-scrim" onClick={() => setDrawerOpen(false)} />
        <main className="main" id="main">
          {page === "worlds" && game && world && <WorldScreen game={game} granted={granted} onDownloadPack={(target, targetWorld) => void downloadPack(target, targetWorld)} onInvite={(target, targetWorld) => setInvite({ game: target, world: targetWorld })} onRefresh={() => void refresh()} onSessionAction={requestSession} onWorldAction={requestWorldAction} pending={pending} serverState={serverState} sharedSession={sharedSession} snapshot={snapshot} world={world} />}
          {page === "worlds" && !(game && world) && <WorldsScreen error={controlPlane.error} game={game} granted={granted} onCreateSave={(target) => setCreating({ game: target, preset: target.presets.find((preset) => preset.buildStatus === "ready") ?? null })} onDownloadPack={(target, targetWorld) => void downloadPack(target, targetWorld)} onInvite={(target, targetWorld) => setInvite({ game: target, world: targetWorld })} onRefresh={() => void refresh()} onSessionAction={requestSession} onWorldAction={requestWorldAction} pending={pending} serverState={serverState} sharedSession={sharedSession} snapshot={snapshot} status={listStatus} />}
          {page === "metrics" && <MetricsScreen game={game} serverState={serverState} />}
          {page === "console" && <ConsoleScreen game={game} serverState={serverState} />}
          {page === "releases" && <ReleasesScreen game={game} granted={granted} loading={listStatus === "loading"} onCreateSave={(target, preset) => setCreating({ game: target, preset })} pending={pending} />}
          {page === "access" && <AccessScreen bootstrap={bootstrap} games={games} members={members} onMembersChange={setMembers} onRolesChange={setRoles} onTabChange={(tab) => navigate({ page: "access", accessTab: tab })} roles={roles} tab={route.accessTab} />}
          {page === "profile" && <ProfileScreen member={currentMember} onSignOut={endSession} role={roles.find((role) => role.id === currentMember.roleId)} viewer={viewer} />}
        </main>
      </div>

      <ScopeDialog currentId={game?.id ?? null} games={games} onClose={() => setScopeOpen(false)} onSelect={selectGame} open={scopeOpen} statusOf={(item) => sessionStatus(deriveServerState(item, snapshot))} />
      {invite && <InvitationSheet game={invite.game} onClose={() => setInvite(null)} open world={invite.world} />}
      {creating && <CreateSaveSheet busy={pending?.kind === "create"} game={creating.game} initialPreset={creating.preset} onClose={() => setCreating(null)} onCreate={(preset, name, release) => void createWorld(creating.game, preset, name, release)} />}
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

function CreateSaveSheet({ game, initialPreset, busy, onClose, onCreate }: { game: Game; initialPreset: Preset | null; busy: boolean; onClose: () => void; onCreate: (preset: Preset, name: string, release: string) => void }) {
  const readyPresets = game.presets.filter((preset) => preset.buildStatus === "ready");
  const [presetId, setPresetId] = useState(initialPreset?.id ?? readyPresets[0]?.id ?? "");
  const preset = game.presets.find((item) => item.id === presetId) ?? null;
  const [name, setName] = useState("");
  const [release, setRelease] = useState(preset?.latestRelease ?? "");
  useEffect(() => setRelease(preset?.latestRelease ?? ""), [preset?.id, preset?.latestRelease]);
  const valid = preset !== null && preset.buildStatus === "ready" && preset.releases.includes(release) && name.trim().length > 0 && name.trim().length <= 80;

  return (
    <Sheet
      description={`A new save opens wipe #1 from an immutable ${game.displayName} release.`}
      footer={<>
        <p>{preset ? `${preset.displayName} · ${preset.releases.length} releases` : "Choose a preset"}</p>
        <Button disabled={!valid} icon="add" loading={busy} onClick={() => { if (preset) onCreate(preset, name.trim(), release); }} variant="filled">Create save</Button>
      </>}
      onClose={onClose}
      open
      title="Create save"
    >
      <form className="page" onSubmit={(event) => { event.preventDefault(); if (preset && valid) onCreate(preset, name.trim(), release); }}>
        <SelectField hint={readyPresets.length === 0 ? "No preset of this game has a ready release." : undefined} label="Preset" onChange={(event) => setPresetId(event.target.value)} value={presetId}>
          {game.presets.map((item) => <option disabled={item.buildStatus !== "ready"} key={item.id} value={item.id}>{item.displayName}{item.buildStatus !== "ready" ? ` (${item.buildStatus})` : ""}</option>)}
        </SelectField>
        <TextField autoComplete="off" data-autofocus hint="1 to 80 characters. Shown in the worlds list and in Telegram." label="Name" maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="For example, Rail world" value={name} />
        <SelectField disabled={!preset} label="Release" onChange={(event) => setRelease(event.target.value)} value={release}>
          <option disabled value="">Choose a release</option>
          {preset && [...preset.releases].reverse().map((version) => <option key={version} value={version}>{version}{version === preset.latestRelease ? " (latest)" : ""}</option>)}
        </SelectField>
      </form>
    </Sheet>
  );
}

function lifecycleLabel(action: WorldActionKind): string {
  return action === "wipe" ? "New wipe" : action === "archive" ? "Archive" : action === "restore" ? "Restore" : "Delete";
}

function deriveServerState(game: Game | undefined, snapshot: ControlPlaneSnapshot | null): ServerState {
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
