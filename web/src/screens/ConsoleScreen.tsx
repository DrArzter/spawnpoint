import { FormEvent, useState } from "react";
import { ServerState } from "../model";
import { Button } from "../components/ui/Button";

const initialLines = [
  "[21:50:53] [Server thread/INFO] Server started",
  "[21:51:02] [Server thread/INFO] RCON running on 0.0.0.0:25575",
  "[21:52:14] [Server thread/INFO] DrArzter joined the game",
  "[21:52:14] [Server thread/INFO] DrArzter[/172.29.10.4] logged in",
];

export function ConsoleScreen({ serverState }: { serverState: ServerState }) {
  const [lines, setLines] = useState(initialLines);
  const [command, setCommand] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!command.trim() || serverState !== "running") return;
    setLines((current) => [...current, `> ${command.trim()}`, "[local prototype] Command accepted"]);
    setCommand("");
  }
  return <>
    <div className="page-heading"><h1>Console</h1><p>RCON commands are recorded with the requesting identity</p></div>
    <section className="terminal-panel">
      <header><span className={`live-mark ${serverState}`}><i />{serverState === "running" ? "Live" : "Disconnected"}</span><Button onClick={() => setLines([])} variant="ghost">Clear</Button></header>
      <div aria-live="polite" className="terminal-output" role="log">{lines.length ? lines.map((line, index) => <p className={line.startsWith(">") ? "command-line" : ""} key={`${line}-${index}`}>{line}</p>) : <span>No console output yet.</span>}</div>
      <form onSubmit={submit}><span>&gt;</span><input aria-label="RCON command" disabled={serverState !== "running"} onChange={(event) => setCommand(event.target.value)} placeholder={serverState === "running" ? "Enter RCON command" : "Start the server to use RCON"} value={command} /><Button className="terminal-run" disabled={serverState !== "running"} type="submit" variant="ghost">Run</Button></form>
    </section>
    <section className="data-section"><div className="section-title"><div><h2>Quick commands</h2><p>Safe, frequently used commands</p></div></div><div className="quick-actions"><Button onClick={() => setCommand("list")}>List players</Button><Button onClick={() => setCommand("save-all flush")}>Save world</Button><Button onClick={() => setCommand("say Server will stop soon")}>Announce stop</Button></div></section>
  </>;
}
