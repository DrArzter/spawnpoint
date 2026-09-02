import { ServerState } from "../model";
import { Button } from "../components/ui/Button";
import { PageHeader, SectionHeader, Surface } from "../components/ui/Page";

export function ConsoleScreen({ serverState }: { serverState: ServerState }) {
  return <>
    <PageHeader description="RCON commands are recorded with the requesting identity" title="Console" />
    <Surface className="terminal-panel">
      <header><span className={`live-mark ${serverState}`}><i />Disconnected</span><Button disabled title="No console stream is connected" variant="ghost">Clear</Button></header>
      <div aria-live="polite" className="terminal-output" role="log"><span>{serverState === "running" ? "The game session is running, but the RCON gateway is not connected yet." : "No active RCON session."}</span></div>
      <form><span>&gt;</span><input aria-label="RCON command" disabled placeholder="RCON gateway is not connected" /><Button className="terminal-run" disabled type="button" variant="ghost">Run</Button></form>
    </Surface>
    <section className="data-section"><SectionHeader description="Available after the authenticated RCON API is implemented" title="Quick commands" /><div className="quick-actions"><Button disabled>List players</Button><Button disabled>Save world</Button><Button disabled>Announce stop</Button></div></section>
  </>;
}
