import { useEffect, useState } from "react";

import { initializeTelegram } from "./telegram";

type World = {
  id: string;
  game: string;
  title: string;
  release: string;
  state: "active" | "available" | "preparing";
};

const worlds: readonly World[] = [
  { id: "world", game: "Minecraft", title: "Modded survival", release: "1.0", state: "active" },
  { id: "factorio", game: "Factorio", title: "Vanilla", release: "2.0.77", state: "available" },
  { id: "zomboid", game: "Project Zomboid", title: "Dedicated server", release: "Draft", state: "preparing" },
];

const stateLabel: Record<World["state"], string> = {
  active: "Selected",
  available: "Available",
  preparing: "Preparing",
};

export function App() {
  const [insideTelegram, setInsideTelegram] = useState(false);
  const [selectedWorld, setSelectedWorld] = useState("world");

  useEffect(() => setInsideTelegram(initializeTelegram()), []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">CONTROL PLANE</p>
          <h1>Spawnpoint</h1>
        </div>
        <span className="preview-label">{insideTelegram ? "TELEGRAM" : "LOCAL PREVIEW"}</span>
      </header>

      <section className="hero" aria-labelledby="server-status-title">
        <div className="status-line">
          <span className="status-dot" aria-hidden="true" />
          <span>HOST STOPPED</span>
        </div>
        <h2 id="server-status-title">Ready when you are.</h2>
        <p>The server costs nothing while stopped. Choose a world before starting a session.</p>
        <dl className="facts">
          <div>
            <dt>Selected world</dt>
            <dd>{worlds.find((world) => world.id === selectedWorld)?.title}</dd>
          </div>
          <div>
            <dt>Last session</dt>
            <dd>Not connected</dd>
          </div>
        </dl>
        <button className="primary-action" type="button" disabled>
          Start session
          <span>Read-only preview</span>
        </button>
      </section>

      <section className="world-section" aria-labelledby="worlds-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">LIBRARY</p>
            <h2 id="worlds-title">Worlds</h2>
          </div>
          <span>{worlds.length}</span>
        </div>

        <div className="world-list">
          {worlds.map((world) => (
            <button
              className={`world-card ${selectedWorld === world.id ? "selected" : ""}`}
              key={world.id}
              onClick={() => setSelectedWorld(world.id)}
              type="button"
            >
              <span className="world-monogram" aria-hidden="true">
                {world.game.slice(0, 2).toUpperCase()}
              </span>
              <span className="world-copy">
                <strong>{world.title}</strong>
                <small>{world.game} · {world.release}</small>
              </span>
              <span className={`world-state ${world.state}`}>{stateLabel[world.state]}</span>
            </button>
          ))}
        </div>
      </section>

      <footer>
        <span>Static preview</span>
        <span>No AWS actions connected</span>
      </footer>
    </main>
  );
}
