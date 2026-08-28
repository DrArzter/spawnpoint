import { Button } from "../components/ui/Button";
import { Icon } from "../Icon";
import type { Game, Host, Operation, ServerState, World } from "../model";

type LoadState = "loading" | "ready" | "error";

export function DashboardScreen({ game, world, hosts, operations, serverState, loadState, error, onRetry, canInvite, canStart, canStop }: {
  game: Game;
  world: World;
  hosts: readonly Host[];
  operations: readonly Operation[];
  serverState: ServerState;
  loadState: LoadState;
  error: string;
  onRetry: () => void;
  canInvite: boolean;
  canStart: boolean;
  canStop: boolean;
}) {
  const activeRelease = world.release.activeRelease;
  const desiredRelease = world.release.desiredRelease;
  const operation = operations[0];
  const host = hosts[0];
  const controlsHint = "Session controls are the next control-plane slice and are not connected yet.";
  const inviteHint = canInvite ? "Telegram invitation delivery is not connected yet." : "Your role cannot send invitations.";
  const stateLabel = serverState === "running" ? "Online" : serverState === "starting" ? "Starting" : serverState === "stopping" ? "Stopping" : serverState === "unknown" ? "Unknown" : "Stopped";

  return <>
    <div className="page-heading"><div><h1>{world.displayName}</h1><p>{game.displayName} · {activeRelease ? `active release ${activeRelease}` : world.release.state === "unconfigured" ? "not adopted yet" : "release unavailable"}</p></div></div>
    {loadState === "error" && <div className="info-banner error-banner" role="alert"><strong>Current state could not be loaded.</strong><span>{error}</span><Button onClick={onRetry}>Try again</Button></div>}
    <section className="service-panel" aria-busy={loadState === "loading"}>
      <div className="service-summary">
        <span className={`service-icon ${serverState}`}><i /></span>
        <div><h2>{loadState === "loading" ? "Loading current state" : stateLabel}</h2><p>{host ? `${host.name} · ${host.state}` : loadState === "ready" ? "No compute host is currently available" : "Reading AWS control-plane state"}</p></div>
      </div>
      <div className="service-actions">
        <Button disabled icon={<Icon name="users" />} title={inviteHint} variant="ghost">Invite players</Button>
        <Button disabled icon={<Icon name={serverState === "running" ? "stop" : "play"} />} title={canStart || canStop ? controlsHint : "Your role cannot control sessions."} variant={serverState === "running" ? "danger" : "primary"}>{serverState === "running" ? "Stop" : "Start"}</Button>
      </div>
    </section>
    <section className="summary-grid">
      <Stat label="Host" value={host?.state ?? (loadState === "loading" ? "Loading…" : "None")} detail={host?.instanceType ?? "Shared compute pool"} />
      <Stat label="Active release" value={activeRelease ?? "—"} detail={activeRelease ? "Last health-checked release" : "No verified active release"} />
      <Stat label="Desired release" value={desiredRelease ?? "—"} detail={desiredRelease ? (desiredRelease === activeRelease ? "Matches active" : "Deployment pending or failed") : "Hidden or not configured"} />
      <Stat label="Operation" value={operation?.type ?? "None"} detail={operation ? `Running since ${formatTime(operation.startedAt)}` : "No operation in progress"} />
    </section>
    <section className="data-section"><div className="section-title"><div><h2>Running operations</h2><p>Step Functions executions affecting the control plane</p></div></div>
      {operations.length > 0 ? <div className="activity-table">{operations.map((item) => <div key={`${item.type}-${item.id}`}><span className="event-dot" /><strong>{operationLabel(item.type)}</strong><span>{item.id}</span><time>{formatTime(item.startedAt)}</time></div>)}</div> : <div className="empty-state"><strong>No operation in progress</strong><p>Completed execution history will be added with the operations API. This view no longer invents activity.</p></div>}
    </section>
  </>;
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="stat"><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}

function operationLabel(type: Operation["type"]): string {
  return type === "start" ? "Starting session" : type === "stop" ? "Stopping session" : "Promoting release";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}
