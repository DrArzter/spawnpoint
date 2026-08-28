import { ServerState } from "../model";
import { Button } from "../components/ui/Button";

export function ConsoleScreen({ serverState }: { serverState: ServerState }) {
  return <>
    <div className="page-heading"><h1>Console</h1><p>RCON commands are recorded with the requesting identity</p></div>
    <section className="terminal-panel">
      <header><span className={`live-mark ${serverState}`}><i />Disconnected</span><Button disabled title="No console stream is connected" variant="ghost">Clear</Button></header>
      <div aria-live="polite" className="terminal-output" role="log"><span>{serverState === "running" ? "The game session is running, but the RCON gateway is not connected yet." : "No active RCON session."}</span></div>
      <form><span>&gt;</span><input aria-label="RCON command" disabled placeholder="RCON gateway is not connected" /><Button className="terminal-run" disabled type="button" variant="ghost">Run</Button></form>
    </section>
    <section className="data-section"><div className="section-title"><div><h2>Quick commands</h2><p>Available after the authenticated RCON API is implemented</p></div></div><div className="quick-actions"><Button disabled>List players</Button><Button disabled>Save world</Button><Button disabled>Announce stop</Button></div></section>
  </>;
}
