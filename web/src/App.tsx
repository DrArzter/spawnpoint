import { useEffect, useMemo, useRef, useState } from "react";

import { ActiveSession, AuthState, endSession, loadControlPlane, requestAccess, requestSessionOperation, restoreAuth, telegramBotUsername, telegramLoginRedirectUrl } from "./auth";
import { AccessScreen } from "./screens/AccessScreen";
import { Avatar } from "./components/Avatar";
import { Button } from "./components/ui/Button";
import { ConsoleScreen } from "./screens/ConsoleScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { MetricsScreen } from "./screens/MetricsScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { StorageScreen } from "./screens/StorageScreen";
import { Icon, IconName } from "./Icon";
import { AccessTab, ControlPlaneSnapshot, Game, initialRoles, Member, OwnerBootstrap, Page, Role, ServerState } from "./model";
import { ensureRoute, pushRoute, readRoute } from "./routing";
import { applyTheme, getThemePreference, initializeTelegram, persistThemePreference, resolveTheme, subscribeToSystemTheme, Theme, ThemePreference, ViewerProfile } from "./telegram";

const navigation: readonly { id: Page; label: string; icon: IconName; permission: string }[] = [
  { id: "dashboard", label: "Overview", icon: "dashboard", permission: "status.read" },
  { id: "metrics", label: "Metrics", icon: "metrics", permission: "metrics.read" },
  { id: "console", label: "Console", icon: "console", permission: "console.use" },
  { id: "storage", label: "Releases", icon: "storage", permission: "release.read" },
  { id: "access", label: "Access", icon: "access", permission: "access.read" },
];

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    restoreAuth()
      .then((state) => { if (active) setAuth(state); })
      .catch((error: unknown) => { if (active) setAuth({ status: "error", message: error instanceof Error ? error.message : "Sign-in failed." }); });
    return () => { active = false; };
  }, []);

  if (auth.status !== "authenticated" || auth.session.state !== "active") {
    return <AuthBoundary auth={auth} onChange={setAuth} />;
  }
  return <AuthenticatedApp session={auth.session} />;
}

function AuthBoundary({ auth, onChange }: { auth: AuthState; onChange: (state: AuthState) => void }) {
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState("");
  const visitor = auth.status === "authenticated" && auth.session.state === "visitor" ? auth.session : null;
  const requested = visitor?.candidate.status === "REQUESTED" || requesting;

  async function sendRequest() {
    setRequestError("");
    try {
      await requestAccess();
      setRequesting(true);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The access request could not be sent.");
    }
  }

  return <main className="auth-shell">
    <section className="auth-panel" aria-busy={auth.status === "loading"}>
      <div className="auth-brand"><span>S</span><strong>Spawnpoint</strong></div>
      {auth.status === "loading" && <><h1>Checking your session</h1><p>Verifying the Telegram account associated with this browser.</p><div className="auth-progress" /></>}
      {auth.status === "signed-out" && <><h1>Sign in with Telegram</h1><p>Telegram verifies who you are. An Owner separately decides which Spawnpoint actions you may use.</p><TelegramLoginButton onError={() => onChange({ status: "error", message: "Telegram Login could not be loaded. Check your connection and try again." })} /><small>Telegram returns you to this page after confirmation.</small></>}
      {auth.status === "unconfigured" && <><h1>Authentication is not configured</h1><p>This build has no Spawnpoint access API or Telegram bot username. Configure the deployment before publishing it.</p></>}
      {auth.status === "error" && <><h1>Could not sign in</h1><p>{auth.message}</p><Button onClick={() => onChange({ status: "signed-out" })} variant="primary">Try again</Button></>}
      {visitor && <><Avatar name={visitor.candidate.displayName} photoUrl={visitor.candidate.photoUrl ?? undefined} size="large" /><h1>{requested ? "Access requested" : "You are signed in"}</h1><p>{requested ? "An Owner can now review your Telegram account in Spawnpoint. The panel will remain locked until access is granted." : "This Telegram account is not approved yet. Send a request and an Owner will be able to assign your role."}</p>{!requested && <Button disabled={requesting} onClick={() => void sendRequest()} variant="primary">Request access</Button>}{requestError && <p className="auth-error" role="alert">{requestError}</p>}<small>Telegram ID {visitor.candidate.telegramId}{visitor.candidate.username ? ` · @${visitor.candidate.username}` : ""}</small></>}
    </section>
  </main>;
}

function TelegramLoginButton({ onError }: { onError: () => void }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = host.current;
    if (container === null) return;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.dataset.telegramLogin = telegramBotUsername;
    script.dataset.size = "large";
    script.dataset.radius = "6";
    script.dataset.userpic = "false";
    script.dataset.authUrl = telegramLoginRedirectUrl();
    script.onerror = onError;
    container.replaceChildren(script);
    return () => container.replaceChildren();
  }, [onError]);

  return <div className="telegram-login" ref={host} />;
}

type ControlPlaneState =
  | { status: "loading"; snapshot: null; error: "" }
  | { status: "ready"; snapshot: ControlPlaneSnapshot; error: "" }
  | { status: "error"; snapshot: null; error: string };

function AuthenticatedApp({ session }: { session: ActiveSession }) {
  const [route, setRoute] = useState(readRoute);
  const { accessTab } = route;
  const granted = useMemo(() => new Set([...(session.role?.permissions ?? []), ...session.identity.directGrants]), [session]);
  const visibleNavigation = useMemo(() => navigation.filter((item) => granted.has(item.permission)), [granted]);
  const page = route.page === "profile" || visibleNavigation.some((item) => item.id === route.page) ? route.page : "dashboard";
  const [controlPlane, setControlPlane] = useState<ControlPlaneState>({ status: "loading", snapshot: null, error: "" });
  const [gameId, setGameId] = useState<string | null>(null);
  const [worldId, setWorldId] = useState<string | null>(null);
  const [themePreference, setThemePreference] = useState<ThemePreference>(getThemePreference);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(getThemePreference()));
  const [picker, setPicker] = useState<"game" | "world" | null>(null);
  const [operationRequest, setOperationRequest] = useState<{ state: "idle" | "pending" | "success" | "error"; message: string }>({ state: "idle", message: "" });
  const [members, setMembers] = useState<Member[]>(() => [{
    id: session.identity.id,
    name: session.identity.displayName,
    roleId: session.identity.roleId,
    links: [{ id: "viewer-telegram", kind: "telegram", value: session.profile.telegramId, verified: true }],
  }]);
  const [roles, setRoles] = useState<Role[]>(initialRoles);
  const [viewer] = useState<ViewerProfile>({
    displayName: session.identity.displayName,
    inTelegram: Boolean(window.Telegram?.WebApp.initData),
    ...(session.profile.username ? { username: session.profile.username } : {}),
    ...(session.profile.photoUrl ? { photoUrl: session.profile.photoUrl } : {}),
    telegramId: session.profile.telegramId,
  });
  const bootstrap: OwnerBootstrap = session.bootstrap.state === "claimed"
    ? { state: "claimed", telegramId: session.bootstrap.telegramId, ownerId: session.bootstrap.ownerId, claimedAt: new Date(session.bootstrap.claimedAt).toLocaleString() }
    : { state: "unclaimed", telegramId: session.profile.telegramId };

  useEffect(() => initializeTelegram(), []);
  useEffect(() => {
    let active = true;
    loadControlPlane()
      .then((snapshot) => { if (active) setControlPlane({ status: "ready", snapshot, error: "" }); })
      .catch((error: unknown) => { if (active) setControlPlane({ status: "error", snapshot: null, error: error instanceof Error ? error.message : "The control-plane state could not be loaded." }); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    ensureRoute();
    const handleRouteChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", handleRouteChange);
    return () => window.removeEventListener("hashchange", handleRouteChange);
  }, []);
  useEffect(() => {
    persistThemePreference(themePreference);
    setTheme(resolveTheme(themePreference));
    if (themePreference === "system") return subscribeToSystemTheme(setTheme);
  }, [themePreference]);
  useEffect(() => applyTheme(theme), [theme]);
  const snapshot = controlPlane.snapshot;
  const games = snapshot?.games ?? [];
  const game = games.find((item) => item.id === gameId) ?? games[0];
  const world = game?.worlds.find((item) => item.id === worldId) ?? game?.worlds[0];
  const serverState = deriveServerState(game, snapshot);
  const currentMember = members.find((member) => member.id === session.identity.id) ?? members[0];

  useEffect(() => {
    if (!game) return;
    if (gameId !== game.id) setGameId(game.id);
    const nextWorld = game.worlds.find((item) => item.id === worldId) ?? game.worlds[0];
    if (nextWorld && worldId !== nextWorld.id) setWorldId(nextWorld.id);
  }, [game, gameId, worldId]);

  async function refreshControlPlane() {
    setControlPlane({ status: "loading", snapshot: null, error: "" });
    try {
      setControlPlane({ status: "ready", snapshot: await loadControlPlane(), error: "" });
    } catch (error) {
      setControlPlane({ status: "error", snapshot: null, error: error instanceof Error ? error.message : "The control-plane state could not be loaded." });
    }
  }

  async function runSessionOperation(action: "start" | "stop") {
    if (!game || !world) return;
    setOperationRequest({ state: "pending", message: action === "start" ? "Requesting session start…" : "Requesting safe stop…" });
    try {
      const result = await requestSessionOperation(game.id, world.id, action);
      setOperationRequest({ state: "success", message: result.result === "already_stopped" ? "The host is already stopped." : `${action === "start" ? "Start" : "Stop"} accepted${result.operationId ? ` · ${result.operationId}` : ""}.` });
      await refreshControlPlane();
    } catch (error) {
      setOperationRequest({ state: "error", message: error instanceof Error ? error.message : `The ${action} request failed.` });
    }
  }

  function selectGame(id: string) {
    const next = games.find((item) => item.id === id);
    if (!next) return;
    setGameId(next.id);
    setWorldId(next.worlds[0]?.id ?? null);
  }

  function toggleTheme() {
    setThemePreference((current) => current === "system" ? (theme === "dark" ? "light" : "dark") : "system");
  }

  function navigate(nextPage: Page, nextAccessTab: AccessTab = accessTab) {
    const nextRoute = { page: nextPage, accessTab: nextAccessTab };
    setRoute(nextRoute);
    pushRoute(nextRoute);
  }

  const themeLabel = themePreference === "system" ? `System theme · ${theme}` : `${themePreference[0].toUpperCase()}${themePreference.slice(1)} theme`;

  return (
    <div className="console-shell">
      <aside className="side-nav">
        <button aria-label="Open my profile" className={`product-mark ${page === "profile" ? "active" : ""}`} onClick={() => navigate("profile")} type="button"><Avatar name={viewer.displayName} photoUrl={viewer.photoUrl} /><strong>Spawnpoint</strong></button>
        <nav aria-label="Main navigation">
          {visibleNavigation.map((item) => (
            <button className={page === item.id ? "active" : ""} key={item.id} onClick={() => navigate(item.id)} type="button">
              <Icon name={item.icon} /><span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="nav-footer">
          <button aria-label={`${themeLabel}. Change theme`} className="theme-toggle" onClick={toggleTheme} title={`${themeLabel}. Click to ${themePreference === "system" ? `use ${theme === "light" ? "dark" : "light"}` : "follow the system"}`} type="button"><Icon name={theme === "light" ? "moon" : "sun"} /><span>{themeLabel}</span></button>
          <button className="identity" onClick={() => navigate("profile")} type="button"><Avatar name={currentMember.name} photoUrl={viewer.photoUrl} /><div><strong>{currentMember.name}</strong><small>{session.role?.name ?? "No role"} · View profile</small></div></button>
        </div>
      </aside>

      <main className="workspace">
        <header className="context-bar">
          <button aria-label="Open my profile" className="mobile-brand" onClick={() => navigate("profile")} type="button"><Avatar name={viewer.displayName} photoUrl={viewer.photoUrl} size="small" /><strong>Spawnpoint</strong></button>
          <div className="context-breadcrumbs" aria-label="Selected game world">
            <span>Games</span><Icon name="arrow" size={14} />
            <div className="crumb-menu"><button aria-expanded={picker === "game"} disabled={!game} onClick={() => setPicker(picker === "game" ? null : "game")} type="button">{game?.displayName ?? "Loading…"}<Icon name="down" size={14} /></button>{picker === "game" && game && <div className="picker-menu">{games.map((item) => <button className={item.id === game.id ? "selected" : ""} key={item.id} onClick={() => { selectGame(item.id); setPicker(null); }} type="button"><span>{item.code}</span><div><strong>{item.displayName}</strong><small>{item.worlds.length} {item.worlds.length === 1 ? "world" : "worlds"}</small></div></button>)}</div>}</div>
            <Icon name="arrow" size={14} />
            <div className="crumb-menu"><button aria-expanded={picker === "world"} disabled={!world} onClick={() => setPicker(picker === "world" ? null : "world")} type="button">{world?.displayName ?? "Unavailable"}<Icon name="down" size={14} /></button>{picker === "world" && game && world && <div className="picker-menu world-picker">{game.worlds.map((item) => <button className={item.id === world.id ? "selected" : ""} key={item.id} onClick={() => { setWorldId(item.id); setPicker(null); }} type="button"><div><strong>{item.displayName}</strong><small>{item.release.activeRelease ? `Active ${item.release.activeRelease}` : item.release.state === "unconfigured" ? "Not adopted" : "Release unavailable"}</small></div></button>)}</div>}</div>
          </div>
          <div className="top-actions"><button aria-label={`${themeLabel}. Change theme`} className="header-theme-toggle" onClick={toggleTheme} title={themeLabel} type="button"><Icon name={theme === "light" ? "moon" : "sun"} /></button><span className={`top-status ${serverState}`}><i />{serverState}</span></div>
        </header>

        <div className="page-content">
          {page === "dashboard" && game && world && <DashboardScreen canInvite={granted.has("invitation.send")} canStart={granted.has("session.start")} canStop={granted.has("session.stop")} error={controlPlane.error} game={game} hosts={snapshot?.hosts ?? []} loadState={controlPlane.status} onOperation={(action) => void runSessionOperation(action)} onRetry={() => void refreshControlPlane()} operationRequest={operationRequest} operations={snapshot?.operations ?? []} serverState={serverState} world={world} />}
          {page === "dashboard" && (!game || !world) && <ControlPlaneUnavailable state={controlPlane} onRetry={() => void refreshControlPlane()} />}
          {page === "metrics" && <MetricsScreen serverState={serverState} />}
          {page === "console" && <ConsoleScreen serverState={serverState} />}
          {page === "storage" && world && <StorageScreen world={world} />}
          {page === "access" && <AccessScreen bootstrap={bootstrap} games={games} members={members} onMembersChange={setMembers} onRolesChange={setRoles} onTabChange={(tab) => navigate("access", tab)} roles={roles} tab={accessTab} />}
          {page === "profile" && currentMember && <ProfileScreen member={currentMember} onChange={(next) => setMembers((current) => current.map((member) => member.id === next.id ? next : member))} onSignOut={endSession} role={roles.find((role) => role.id === currentMember.roleId)} viewer={viewer} />}
        </div>
      </main>

      <nav className="bottom-nav" aria-label="Mobile navigation">
        {visibleNavigation.map((item) => <button className={page === item.id ? "active" : ""} key={item.id} onClick={() => navigate(item.id)} type="button"><Icon name={item.icon} /><span>{item.label}</span></button>)}
      </nav>
    </div>
  );
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

function ControlPlaneUnavailable({ state, onRetry }: { state: ControlPlaneState; onRetry: () => void }) {
  return <><div className="page-heading"><h1>Overview</h1><p>Games, worlds and current AWS state</p></div><div className="empty-state" aria-busy={state.status === "loading"}><strong>{state.status === "loading" ? "Loading control-plane state" : "Control-plane state unavailable"}</strong><p>{state.status === "error" ? state.error : "Reading games, worlds, hosts and running operations."}</p>{state.status === "error" && <Button onClick={onRetry}>Try again</Button>}</div></>;
}
