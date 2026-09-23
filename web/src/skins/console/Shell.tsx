import { useEffect, useState, type ReactNode } from "react";

import { Avatar } from "../../components/Avatar";
import { IconButton } from "../../components/ui/Button";
import { Icon } from "../../icons";
import type { BootModel, ShellModel } from "../../core/models";
import { BootScreen } from "../../screens/AuthScreen";
import { DemoBadge, SpawnpointMark } from "../../shell/AppBar";
import { useMediaQuery, useStoredState } from "../../shell/hooks";

const icons = { worlds: "public", metrics: "bar_chart", console: "terminal", releases: "inventory", access: "group", profile: "person" } as const;

// The Cloud console frame: a sticky app bar with the scope chip, a drawer that
// collapses to a rail on narrow desktops and hides behind the menu button on
// phones, and the content pane with no maximum width.
export function Shell({ model, children }: Readonly<{ model: ShellModel; children: ReactNode }>) {
  const mobile = useMediaQuery("(max-width: 959px)");
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The drawer collapses to an icon rail on narrow desktops until the person
  // chooses; a stored choice wins on every width above the phone breakpoint.
  const [railChoice, setRailChoice] = useStoredState<"true" | "false" | "auto">("spawnpoint.rail", "auto");
  const narrowDesktop = useMediaQuery("(min-width: 960px) and (max-width: 1199px)");
  const rail = railChoice === "auto" ? narrowDesktop : railChoice === "true";
  const current = model.navigation.find((item) => item.current)?.id;

  useEffect(() => { setDrawerOpen(false); }, [current, mobile]);
  // Escape closes what overlays the page, the drawer included.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawerOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className="shell" data-drawer-open={mobile && drawerOpen ? "true" : undefined} data-rail={!mobile && rail ? "true" : undefined}>
      <header className="appbar">
        <IconButton icon="menu" label="Toggle navigation" onClick={() => (mobile ? setDrawerOpen((open) => !open) : setRailChoice(rail ? "false" : "true"))} />
        <a className="appbar-brand" href="#/worlds">
          <SpawnpointMark />
          <strong>Spawnpoint</strong>
        </a>
        <span aria-hidden="true" className="appbar-divider" />
        <button aria-haspopup="dialog" className="appbar-scope" data-action={model.scope.show.id} disabled={model.scope.show.disabled} onClick={model.scope.show.run} title={model.scope.show.hint} type="button">
          <Icon name="sports_esports" size={20} />
          <span>{model.scope.show.label}</span>
          <Icon name="unfold_more" size={18} />
        </button>
        <span className="appbar-spacer" />
        <div className="appbar-actions">
          {model.demo && <DemoBadge />}
          <IconButton data-action={model.cycleTheme.id} icon={model.appearance.theme === "dark" ? "light_mode" : "dark_mode"} label={model.cycleTheme.label} onClick={model.cycleTheme.run} />
          <button aria-label={model.openProfile.label} className="appbar-avatar" data-action={model.openProfile.id} onClick={model.openProfile.run} title={model.viewer.displayName} type="button">
            <Avatar name={model.viewer.displayName} photoUrl={model.viewer.photoUrl} />
          </button>
        </div>
      </header>
      <div className="shell-body">
        <aside className="drawer" id="navigation-drawer">
          <nav aria-label="Main navigation">
            {model.navigation.map((item) => (
              <a aria-current={item.current ? "page" : undefined} className="drawer-item" href={item.href} key={item.id} onClick={() => setDrawerOpen(false)} title={item.label}>
                <Icon name={icons[item.id]} size={22} />
                <span>{item.label}</span>
              </a>
            ))}
          </nav>
          {model.observedAt && (
            <div className="drawer-footer">
              Control plane observed
              <strong>{model.observedAt}</strong>
            </div>
          )}
        </aside>
        {/* Pointer-down, not click: a tap that moves a hair produces no click at
            all, so the drawer ignored half the taps meant to dismiss it. */}
        <div aria-hidden="true" className="drawer-scrim" onPointerDown={() => setDrawerOpen(false)} />
        <main className="main" id="main">
          {children}
        </main>
      </div>
    </div>
  );
}

export function Boot({ model }: Readonly<{ model: BootModel }>) {
  return <BootScreen description={model.description} title={model.title} />;
}
