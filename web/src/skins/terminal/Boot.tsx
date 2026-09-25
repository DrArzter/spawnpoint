import { useEffect } from "react";

import type { BootModel } from "../../core/models";
import { SpawnpointMark } from "../../shell/AppBar";
import { ensureTerminalFont } from "./font";
import { State } from "./ui";

// The screen before there is a shell: the same boxed panel as any other,
// named on its rule, the step in progress as a spinning mark and a word, and
// a block sweeping a bracketed track the width of the panel. It wears the
// face from the first frame because index.html stamps the remembered skin.
export function Boot({ model }: Readonly<{ model: BootModel }>) {
  useEffect(ensureTerminalFont, []);
  return (
    <main aria-busy="true" aria-live="polite" className="t-boot" role="status">
      <section aria-labelledby="t-boot-title" className="t-panel t-panel-named t-boot-panel">
        <h2 className="t-panel-name">Boot</h2>
        <div className="t-panel-body t-boot-body">
          <div className="t-boot-brand"><SpawnpointMark size={24} /><strong>Spawnpoint</strong></div>
          <h1 className="t-boot-title" id="t-boot-title"><State kind="progress" label={model.title} size="large" /></h1>
          <p>{model.description}</p>
          <div aria-hidden="true" className="t-track" />
        </div>
      </section>
    </main>
  );
}
