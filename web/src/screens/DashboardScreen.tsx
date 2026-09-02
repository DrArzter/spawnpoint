import { Button } from "../components/ui/Button";
import { InvitationComposer } from "../components/InvitationComposer";
import { EmptyState, KeyValueGrid, Notice, PageHeader, SectionHeader, Surface } from "../components/ui/Page";
import { Icon } from "../Icon";
import { useEffect, useRef, useState } from "react";
import type { Game, Host, Operation, ServerState, World } from "../model";

type LoadState = "loading" | "ready" | "error";

export function DashboardScreen({ game, world, hosts, operations, serverState, loadState, error, onRetry, onOperation, operationRequest, canInvite, canStart, canStop }: {
  game: Game;
  world: World;
  hosts: readonly Host[];
  operations: readonly Operation[];
  serverState: ServerState;
  loadState: LoadState;
  error: string;
  onRetry: () => void;
  onOperation: (action: "start" | "stop") => void;
  operationRequest: { state: "idle" | "pending" | "success" | "error"; message: string };
  canInvite: boolean;
  canStart: boolean;
  canStop: boolean;
}) {
  const [confirming, setConfirming] = useState<"start" | "stop" | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const activeRelease = world.release.activeRelease;
  const operation = operations[0];
  const host = hosts[0];
  const sessionAction = serverState === "running" ? "stop" : "start";
  const permitted = sessionAction === "start" ? canStart : canStop;
  const transitioning = serverState === "starting" || serverState === "stopping" || operationRequest.state === "pending";
  const controlDisabled = !world.sessionControlAvailable || !permitted || transitioning;
  const controlsHint = !world.sessionControlAvailable
    ? world.materialization === "not_created"
      ? world.preset?.buildStatus === "ready" ? "World creation is not deployed yet." : "This preset needs a successful release build before its first start."
      : "This world is not connected to a session workflow yet."
    : !permitted ? `Your role cannot ${sessionAction} sessions.` : transitioning ? "A control-plane operation is already in progress." : `Review and confirm the ${sessionAction} request.`;
  const inviteHint = canInvite ? "Invite everyone or choose specific players." : "Your role cannot send invitations.";
  const stateLabel = serverState === "running" ? "Online" : serverState === "starting" ? "Starting" : serverState === "stopping" ? "Stopping" : serverState === "unknown" ? "Unknown" : "Stopped";

  useEffect(() => { if (confirming) confirmButton.current?.focus(); }, [confirming]);

  function confirmOperation() {
    if (!confirming) return;
    onOperation(confirming);
    setConfirming(null);
  }

  return <>
    <PageHeader description={`${game.displayName} · ${activeRelease ? `active release ${activeRelease}` : world.materialization === "not_created" ? `preset ${world.preset?.buildStatus ?? "unbuilt"} · world not created` : world.release.state === "unconfigured" ? "no release selected" : "release unavailable"}`} title={world.displayName} />
    {loadState === "error" && <Notice action={<Button onClick={onRetry}>Try again</Button>} description={error} title="Current state could not be loaded" tone="danger" />}
    <section className="service-panel" aria-busy={loadState === "loading"}>
      <div className="service-summary">
        <span className={`service-icon ${serverState}`}><i /></span>
        <div><h2>{loadState === "loading" ? "Loading current state" : stateLabel}</h2><p>{host ? `${host.name}${host.instanceType ? ` · ${host.instanceType}` : ""}` : loadState === "ready" ? "No compute host is currently available" : "Reading AWS control-plane state"}</p></div>
      </div>
      <div className="service-actions">
        <Button disabled={!canInvite} icon={<Icon name="users" />} onClick={() => setInviteOpen((open) => !open)} title={inviteHint} variant="ghost">Invite players</Button>
        <Button disabled={controlDisabled} icon={<Icon name={sessionAction === "stop" ? "stop" : "play"} />} onClick={() => setConfirming(sessionAction)} title={controlsHint} variant={sessionAction === "stop" ? "danger" : "primary"}>{sessionAction === "stop" ? "Stop" : "Start"}</Button>
      </div>
    </section>
    {inviteOpen && <InvitationComposer game={game} onClose={() => setInviteOpen(false)} world={world} />}
    {confirming && <Surface aria-labelledby="operation-confirmation-title" className="operation-confirmation" role="alertdialog">
      <div><h2 id="operation-confirmation-title">{confirming === "start" ? "Start a billed AWS session?" : "Save, back up and stop this session?"}</h2><p>{confirming === "start" ? `Spawnpoint will boot the host and start ${world.displayName}. The game may take several minutes to become healthy.` : "Spawnpoint will refuse while players are online, then save the world, create a verified backup and stop the host."}</p></div>
      <div><Button onClick={() => setConfirming(null)} variant="ghost">Cancel</Button><Button onClick={confirmOperation} ref={confirmButton} variant={confirming === "stop" ? "danger" : "primary"}>{confirming === "start" ? "Start session" : "Stop session"}</Button></div>
    </Surface>}
    {operationRequest.state !== "idle" && <Notice description={operationRequest.message} title={operationRequest.state === "pending" ? "Operation requested" : operationRequest.state === "success" ? "Operation accepted" : "Operation failed"} tone={operationRequest.state === "error" ? "danger" : operationRequest.state === "success" ? "success" : "info"} />}
    <KeyValueGrid label="World state summary" items={[
      { label: "Connection", value: world.connectionAddress ?? "—", detail: world.connectionAddress ? (world.connectivity === "raw" ? "Current public address" : "ZeroTier address") : serverState === "running" ? "Address unavailable" : "Available while the session is online" },
      { label: "Host", value: host?.state ?? (loadState === "loading" ? "Loading…" : "None"), detail: host?.instanceType ?? "Shared compute pool" },
      { label: "Active release", value: activeRelease ?? "—", detail: activeRelease ? "Last health-checked release" : "No verified active release" },
      { label: "Operation", value: operation?.type ?? "None", detail: operation ? `Running since ${formatTime(operation.startedAt)}` : "No operation in progress" },
    ]} />
    <Surface className="data-section"><SectionHeader description="Step Functions executions affecting the control plane" title="Running operations" />
      {operations.length > 0 ? <div className="activity-table">{operations.map((item) => <div key={`${item.type}-${item.id}`}><span className="event-dot" /><strong>{operationLabel(item.type)}</strong><span>{item.id}</span><time>{formatTime(item.startedAt)}</time></div>)}</div> : <EmptyState description="Completed execution history will appear after the operations API exposes it. Spawnpoint does not invent activity." icon="dashboard" title="No operation in progress" />}
    </Surface>
  </>;
}

function operationLabel(type: Operation["type"]): string {
  return type === "start" ? "Starting session" : type === "stop" ? "Stopping session" : "Promoting release";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}
