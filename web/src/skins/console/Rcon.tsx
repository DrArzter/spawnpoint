import { Button, IconButton } from "../../components/ui/Button";
import { Status } from "../../components/ui/Status";
import { NotConnected } from "../../components/ui/Surfaces";
import type { ConsoleModel } from "../../core/models";
import { Icon } from "../../icons";

// The console commits to the terminal grammar: typed command, acknowledged
// reply, a standby cursor. Nothing here pretends a gateway exists.
export function Rcon({ model }: Readonly<{ model: ConsoleModel }>) {
  const { game, online, session } = model;
  return (
    <div className="page">
      <h1 className="visually-hidden">Console</h1>
      <NotConnected description="The terminal below shows the session it would attach to." inline title="The RCON gateway is not connected yet." />
      <section aria-label="RCON terminal" className="terminal">
        <header className="terminal-bar">
          <Icon name="terminal" size={18} />
          <strong>{game ? `${game.displayName} session` : "Session"}</strong>
          <Status className="terminal-status" kind={session.kind} label={session.label} />
          <IconButton disabled icon="close" label="Clear output (no output yet)" />
        </header>
        <div aria-live="polite" className="terminal-output" role="log">
          <span className="line line-muted">spawnpoint console · {game?.id ?? "no game"} · rcon gateway: not deployed</span>
          <span className="line line-blue">{online ? `${game?.displayName ?? "The game"} is online. The console will attach to this session once the gateway exists.` : "The console attaches only to a running session."}</span>
          <span className="line line-amber">{online ? "stop and save commands stay in the Worlds page until the gateway records who issued them." : "Start a session from Worlds to have something to attach to."}</span>
          <span className="line"><span className="prompt">rcon&gt;</span> <span aria-hidden="true" className="cursor" /></span>
        </div>
        <form className="terminal-input" onSubmit={(event) => event.preventDefault()}>
          <span aria-hidden="true" className="prompt">rcon&gt;</span>
          <input aria-label="RCON command" disabled placeholder="Gateway not connected" />
          <Button disabled icon="keyboard_return" size="small" variant="text">Run</Button>
        </form>
      </section>
      <div aria-label="Quick commands" className="quick-commands" role="group">
        {model.quickCommands.map((command) => <Button disabled key={command} size="small" title="Available once the RCON gateway is connected" variant="outlined"><code>{command}</code></Button>)}
      </div>
    </div>
  );
}
