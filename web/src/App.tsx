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
  const [selectedWorld, setSelectedWorld] = useState("world");

  useEffect(() => {
    initializeTelegram();
  }, []);

  return (
    <main className="app-shell">
      <section className="hero" aria-labelledby="server-status-title">
        <div className="status-line">
          <span className="status-dot" aria-hidden="true" />
          <span>Server stopped</span>
        </div>
        <h2 id="server-status-title">Choose a world</h2>
        <p>Only one world can run at a time.</p>
        <dl className="facts">
          <div>
            <dt>Selected</dt>
            <dd>{worlds.find((world) => world.id === selectedWorld)?.title}</dd>
          </div>
          <div>
            <dt>Game</dt>
            <dd>{worlds.find((world) => world.id === selectedWorld)?.game}</dd>
          </div>
        </dl>
        <button className="primary-action" type="button" disabled>
          Start server
        </button>
      </section>

      <section className="world-section" aria-labelledby="worlds-title">
        <div className="section-heading">
          <h2 id="worlds-title">Worlds</h2>
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

    </main>
  );
}
