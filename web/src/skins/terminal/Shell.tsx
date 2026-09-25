import { useEffect, type ReactNode } from "react";

import type { ShellModel } from "../../core/models";
import { SpawnpointMark } from "../../shell/AppBar";
import { ensureTerminalFont } from "./font";
import { Avatar, IconKey } from "./ui";

// The screen: a top row, a menu row, then the grid. Nothing sits beside the
// content; every row runs the whole width, on a phone as on a 4K monitor.
// The document wears the skin's mark from index.html and App (skins/index.ts,
// wearOnDocument); the shell only makes sure its face has loaded.
export function Shell({ model, children }: Readonly<{ model: ShellModel; children: ReactNode }>) {
  useEffect(ensureTerminalFont, []);

  return (
    <div className="t-shell">
      <header className="t-bar">
        <a className="t-brand" href="#/worlds">
          <SpawnpointMark size={24} />
          <strong>Spawnpoint</strong>
        </a>
        <button aria-haspopup="dialog" className="t-scope" data-action={model.scope.show.id} disabled={model.scope.show.disabled} onClick={model.scope.show.run} title={model.scope.show.hint} type="button">
          <span aria-hidden="true" className="t-bracket">[</span>
          <span className="t-scope-name">{model.scope.show.label}</span>
          <span aria-hidden="true" className="t-scope-caret">▾</span>
          <span aria-hidden="true" className="t-bracket">]</span>
        </button>
        <span className="t-bar-gap" />
        <div className="t-bar-verbs">
          {model.demo && <span className="t-demo">Demo data</span>}
          <IconKey data-action={model.cycleTheme.id} icon={model.appearance.theme === "dark" ? "light_mode" : "dark_mode"} label={model.cycleTheme.label} onClick={model.cycleTheme.run} />
          <button aria-label={model.openProfile.label} className="t-bar-avatar" data-action={model.openProfile.id} onClick={model.openProfile.run} title={model.viewer.displayName} type="button">
            <Avatar name={model.viewer.displayName} photoUrl={model.viewer.photoUrl} size="small" />
          </button>
        </div>
      </header>
      {/* Scrolls sideways on a narrow screen by design; the half-visible next
          destination is the affordance. */}
      <nav aria-label="Main navigation" className="t-menu-row" data-scroll="expected">
        {model.navigation.map((item) => (
          <a aria-current={item.current ? "page" : undefined} className="t-menu-link" href={item.href} key={item.id}>{item.label}</a>
        ))}
        {model.observedAt && <span className="t-menu-note"><span>observed</span> <strong>{model.observedAt}</strong></span>}
      </nav>
      <main className="t-main" id="main">
        {children}
      </main>
    </div>
  );
}
