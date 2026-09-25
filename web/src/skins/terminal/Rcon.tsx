import type { ConsoleModel } from "../../core/models";
import { Key, Page, State } from "./ui";

// The console page is the one place the two faces agree on: a terminal. Here
// it is the whole screen's own grammar continued: a named panel, the session
// state in its head, the log, the prompt, the quick commands as keys.
export function Rcon({ model }: Readonly<{ model: ConsoleModel }>) {
  const { game, online, session } = model;
  return (
    <Page>
      <h1 className="visually-hidden">Console</h1>
      <p className="t-note"><span aria-hidden="true" className="t-mark t-mark-off">[-]</span><strong>The RCON gateway is not connected yet.</strong> The terminal below shows the session it would attach to.</p>
      <section aria-label="RCON terminal" className="t-rcon">
        <header className="t-rcon-head">
          <strong>{game ? `${game.displayName} session` : "Session"}</strong>
          <State kind={session.kind} label={session.label} />
        </header>
        <div aria-live="polite" className="t-rcon-log" role="log">
          <span className="t-rcon-line t-rcon-muted">spawnpoint console · {game?.id ?? "no game"} · rcon gateway: not deployed</span>
          <span className="t-rcon-line t-rcon-blue">{online ? `${game?.displayName ?? "The game"} is online. The console will attach to this session once the gateway exists.` : "The console attaches only to a running session."}</span>
          <span className="t-rcon-line t-rcon-amber">{online ? "stop and save commands stay in the Worlds page until the gateway records who issued them." : "Start a session from Worlds to have something to attach to."}</span>
          <span className="t-rcon-line"><span className="t-rcon-prompt">rcon&gt;</span> <span aria-hidden="true" className="t-rcon-cursor" /></span>
        </div>
        <form className="t-rcon-input" onSubmit={(event) => event.preventDefault()}>
          <span aria-hidden="true" className="t-rcon-prompt">rcon&gt;</span>
          <input aria-label="RCON command" disabled placeholder="Gateway not connected" />
          <Key disabled icon="keyboard_return" label="Run" size="small" />
        </form>
      </section>
      <fieldset className="t-quick">
        <legend className="visually-hidden">Quick commands</legend>
        {model.quickCommands.map((command) => <Key disabled key={command} label={<code>{command}</code>} size="small" title="Available once the RCON gateway is connected" />)}
      </fieldset>
    </Page>
  );
}
