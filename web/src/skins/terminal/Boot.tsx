import { useEffect } from "react";

import { Status } from "../../components/ui/Status";
import type { BootModel } from "../../core/models";
import { SpawnpointMark } from "../../shell/AppBar";
import { ensureTerminalFont } from "./font";

// The screen before there is a shell: the same boxed panel as any other,
// named on its rule, the step in progress as a spinning mark and a word, and
// the console's own indeterminate bar, square here. It wears the face from
// the first frame because index.html stamps the remembered skin.
export function Boot({ model }: Readonly<{ model: BootModel }>) {
  useEffect(ensureTerminalFont, []);
  return (
    <main aria-busy="true" aria-live="polite" className="boot tboot" role="status">
      <section aria-labelledby="tboot-title" className="card tboot-card">
        <header className="card-header"><div><h2>Boot</h2></div></header>
        <div className="card-body tboot-body">
          <div className="tboot-brand"><SpawnpointMark size={24} /><strong>Spawnpoint</strong></div>
          <h1 className="tboot-title" id="tboot-title"><Status kind="progress" label={model.title} size="large" /></h1>
          <p>{model.description}</p>
          <div aria-hidden="true" className="boot-progress" />
        </div>
      </section>
    </main>
  );
}
