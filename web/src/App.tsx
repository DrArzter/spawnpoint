import { useEffect, useMemo, useState } from "react";

import { AccessScreen } from "./screens/AccessScreen";
import { Avatar } from "./components/Avatar";
import { ConsoleScreen } from "./screens/ConsoleScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { MetricsScreen } from "./screens/MetricsScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { StorageScreen } from "./screens/StorageScreen";
import { Icon, IconName } from "./Icon";
import { games, initialMembers, initialOwnerBootstrap, initialRoles, Member, Page, Role, ServerState } from "./model";
import { applyTheme, getPreferredTheme, getViewerProfile, initializeTelegram, Theme } from "./telegram";

const navigation: readonly { id: Page; label: string; icon: IconName }[] = [
  { id: "dashboard", label: "Overview", icon: "dashboard" },
  { id: "metrics", label: "Metrics", icon: "metrics" },
  { id: "console", label: "Console", icon: "console" },
  { id: "storage", label: "Releases", icon: "storage" },
  { id: "access", label: "Access", icon: "access" },
];

export function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [gameId, setGameId] = useState(games[0].id);
  const [worldId, setWorldId] = useState(games[0].worlds[0].id);
  const [serverState, setServerState] = useState<ServerState>("stopped");
  const [notice, setNotice] = useState("");
  const [theme, setTheme] = useState<Theme>(getPreferredTheme);
  const [picker, setPicker] = useState<"game" | "world" | null>(null);
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [roles, setRoles] = useState<Role[]>(initialRoles);
  const [viewer] = useState(getViewerProfile);

  useEffect(() => initializeTelegram(setTheme), []);
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const game = useMemo(() => games.find((item) => item.id === gameId) ?? games[0], [gameId]);
  const world = useMemo(() => game.worlds.find((item) => item.id === worldId) ?? game.worlds[0], [game, worldId]);

  function selectGame(id: string) {
    const next = games.find((item) => item.id === id) ?? games[0];
    setGameId(next.id);
    setWorldId(next.worlds[0].id);
  }

  function toggleServer() {
    if (serverState === "running") return setServerState("stopped");
    if (!world.ready || serverState === "starting") return;
    setServerState("starting");
    window.setTimeout(() => setServerState("running"), 900);
  }

  return (
    <div className="console-shell">
      <aside className="side-nav">
        <button aria-label="Open my profile" className={`product-mark ${page === "profile" ? "active" : ""}`} onClick={() => setPage("profile")} type="button"><Avatar name={viewer.displayName} photoUrl={viewer.photoUrl} /><strong>Spawnpoint</strong></button>
        <nav aria-label="Main navigation">
          {navigation.map((item) => (
            <button className={page === item.id ? "active" : ""} key={item.id} onClick={() => setPage(item.id)} type="button">
              <Icon name={item.icon} /><span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="nav-footer">
          <button aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`} className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} type="button"><Icon name={theme === "light" ? "moon" : "sun"} /><span>{theme === "light" ? "Dark theme" : "Light theme"}</span></button>
          <button className="identity" onClick={() => setPage("profile")} type="button"><Avatar name={members[0].name} photoUrl={viewer.photoUrl} /><div><strong>{members[0].name}</strong><small>Owner · View profile</small></div></button>
        </div>
      </aside>

      <main className="workspace">
        <header className="context-bar">
          <button aria-label="Open my profile" className="mobile-brand" onClick={() => setPage("profile")} type="button"><Avatar name={viewer.displayName} photoUrl={viewer.photoUrl} size="small" /><strong>Spawnpoint</strong></button>
          <div className="context-breadcrumbs" aria-label="Selected game world">
            <span>Games</span><Icon name="arrow" size={14} />
            <div className="crumb-menu"><button aria-expanded={picker === "game"} onClick={() => setPicker(picker === "game" ? null : "game")} type="button">{game.title}<Icon name="down" size={14} /></button>{picker === "game" && <div className="picker-menu">{games.map((item) => <button className={item.id === game.id ? "selected" : ""} key={item.id} onClick={() => { selectGame(item.id); setPicker(null); }} type="button"><span>{item.code}</span><div><strong>{item.title}</strong><small>{item.worlds.length} {item.worlds.length === 1 ? "world" : "worlds"}</small></div></button>)}</div>}</div>
            <Icon name="arrow" size={14} />
            <div className="crumb-menu"><button aria-expanded={picker === "world"} onClick={() => setPicker(picker === "world" ? null : "world")} type="button">{world.title}<Icon name="down" size={14} /></button>{picker === "world" && <div className="picker-menu world-picker">{game.worlds.map((item) => <button className={item.id === world.id ? "selected" : ""} key={item.id} onClick={() => { setWorldId(item.id); setPicker(null); }} type="button"><div><strong>{item.title}</strong><small>Release {item.release}</small></div></button>)}</div>}</div>
          </div>
          <div className="top-actions"><button aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`} className="header-theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} type="button"><Icon name={theme === "light" ? "moon" : "sun"} /></button><span className={`top-status ${serverState}`}><i />{serverState}</span></div>
        </header>

        <div className="page-content">
          {page === "dashboard" && <DashboardScreen game={game} members={members} onInvite={(count) => setNotice(`Invitation prepared for ${count} ${count === 1 ? "player" : "players"}`)} onToggle={toggleServer} serverState={serverState} world={world} />}
          {page === "metrics" && <MetricsScreen serverState={serverState} />}
          {page === "console" && <ConsoleScreen serverState={serverState} />}
          {page === "storage" && <StorageScreen world={world} />}
          {page === "access" && <AccessScreen bootstrap={initialOwnerBootstrap} members={members} onMembersChange={setMembers} onRolesChange={setRoles} roles={roles} />}
          {page === "profile" && <ProfileScreen member={members[0]} onChange={(next) => setMembers((current) => current.map((member) => member.id === next.id ? next : member))} role={roles.find((role) => role.id === members[0].roleId)} viewer={viewer} />}
        </div>
      </main>

      <nav className="bottom-nav" aria-label="Mobile navigation">
        {navigation.map((item) => <button className={page === item.id ? "active" : ""} key={item.id} onClick={() => setPage(item.id)} type="button"><Icon name={item.icon} /><span>{item.label}</span></button>)}
      </nav>
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}
