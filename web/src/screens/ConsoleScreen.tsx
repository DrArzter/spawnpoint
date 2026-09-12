import { Button, IconButton } from "../components/ui/Button";
import { Banner, PageHeader } from "../components/ui/Surfaces";
import { Icon } from "../icons";
import type { Game, ServerState } from "../model";

// The console commits to the terminal grammar: typed command, acknowledged
// reply, a standby cursor. Nothing here pretends a gateway exists.
export function ConsoleScreen({ game, serverState }: { game: Game | undefined; serverState: ServerState }) {
  const online = serverState === "running";
  return (
    <div className="page">
      <PageHeader description="RCON commands run with your Spawnpoint identity and are recorded against it." title="Console" />
      <Banner description="Commands will be accepted here once the authenticated RCON API is deployed. The terminal shows the session it would attach to." title="The RCON gateway is not connected yet" tone="info" />
      <section aria-label="RCON terminal" className="terminal">
        <header className="terminal-bar">
          <Icon name="terminal" size={18} />
          <strong>{game ? `${game.displayName} session` : "Session"}</strong>
          <span className={`terminal-status${online ? " online" : ""}`}>
            <Icon name={online ? "check_circle" : "radio_button_unchecked"} size={14} />
            {online ? "Session online · gateway disconnected" : "No active session"}
          </span>
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
        {["list", "save-all", "say Server stops in 5 minutes"].map((command) => <Button disabled key={command} size="small" title="Available once the RCON gateway is connected" variant="outlined"><code>{command}</code></Button>)}
      </div>
    </div>
  );
}
