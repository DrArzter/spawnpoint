import { useEffect, type ReactNode } from "react";

import { Avatar } from "../../components/Avatar";
import { IconButton } from "../../components/ui/Button";
import type { BootModel, ShellModel } from "../../core/models";
import { BootScreen } from "../../screens/AuthScreen";
import { DemoBadge, SpawnpointMark } from "../../shell/AppBar";

const FONT_URL = "https://fonts.googleapis.com/css2?family=B612+Mono:wght@400;700&display=swap";

// The screen: a top row, a menu row, then the grid. Nothing sits beside the
// content; every row runs the whole width, on a phone as on a 4K monitor.
// The skin marks the document while it is mounted, so its stylesheet applies
// to the console alone and never to the front door.
export function Shell({ model, children }: Readonly<{ model: ShellModel; children: ReactNode }>) {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.skin = "terminal";
    if (!document.querySelector(`link[href="${FONT_URL}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = FONT_URL;
      document.head.append(link);
    }
    return () => { delete root.dataset.skin; };
  }, []);

  return (
    <div className="tshell">
      <header className="tbar">
        <a className="tbrand" href="#/worlds">
          <SpawnpointMark size={24} />
          <strong>Spawnpoint</strong>
        </a>
        <button aria-haspopup="dialog" className="tscope" data-action={model.scope.show.id} disabled={model.scope.show.disabled} onClick={model.scope.show.run} title={model.scope.show.hint} type="button">
          <span>{model.scope.show.label}</span>
          <span aria-hidden="true" className="tscope-caret">▾</span>
        </button>
        <span className="tbar-spacer" />
        <div className="tbar-actions">
          {model.demo && <DemoBadge />}
          <IconButton data-action={model.cycleTheme.id} icon={model.appearance.theme === "dark" ? "light_mode" : "dark_mode"} label={model.cycleTheme.label} onClick={model.cycleTheme.run} />
          <button aria-label={model.openProfile.label} className="tavatar" data-action={model.openProfile.id} onClick={model.openProfile.run} title={model.viewer.displayName} type="button">
            <Avatar name={model.viewer.displayName} photoUrl={model.viewer.photoUrl} />
          </button>
        </div>
      </header>
      {/* Scrolls sideways on a narrow screen by design; the half-visible next
          destination is the affordance. */}
      <nav aria-label="Main navigation" className="tmenu" data-scroll="expected">
        {model.navigation.map((item) => (
          <a aria-current={item.current ? "page" : undefined} className="tmenu-item" href={item.href} key={item.id}>{item.label}</a>
        ))}
        {model.observedAt && <span className="tmenu-note"><span>observed</span> <strong>{model.observedAt}</strong></span>}
      </nav>
      <main className="tmain" id="main">
        {children}
      </main>
    </div>
  );
}

export function Boot({ model }: Readonly<{ model: BootModel }>) {
  return <BootScreen description={model.description} title={model.title} />;
}
