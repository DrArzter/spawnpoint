import { Button } from "../components/ui/Button";
import { Icon } from "../Icon";
import { useEffect, useRef, useState } from "react";
import type { Game, Host, Operation, ServerState, World } from "../model";
import { loadInvitationRecipients, sendInvitation, type InvitationRecipient } from "../auth";

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
  const [audience, setAudience] = useState<"broadcast" | "direct">("broadcast");
  const [recipients, setRecipients] = useState<InvitationRecipient[]>([]);
  const [selectedRecipients, setSelectedRecipients] = useState<Set<string>>(new Set());
  const [recipientQuery, setRecipientQuery] = useState("");
  const [recipientState, setRecipientState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [inviteRequest, setInviteRequest] = useState<{ state: "idle" | "pending" | "success" | "error"; message: string }>({ state: "idle", message: "" });
  const confirmButton = useRef<HTMLButtonElement>(null);
  const activeRelease = world.release.activeRelease;
  const desiredRelease = world.release.desiredRelease;
  const operation = operations[0];
  const host = hosts[0];
  const sessionAction = serverState === "running" ? "stop" : "start";
  const permitted = sessionAction === "start" ? canStart : canStop;
  const transitioning = serverState === "starting" || serverState === "stopping" || operationRequest.state === "pending";
  const controlDisabled = !world.sessionControlAvailable || !permitted || transitioning;
  const controlsHint = !world.sessionControlAvailable ? "This world is not connected to a session workflow yet." : !permitted ? `Your role cannot ${sessionAction} sessions.` : transitioning ? "A control-plane operation is already in progress." : `Review and confirm the ${sessionAction} request.`;
  const inviteHint = canInvite ? "Invite everyone or choose specific players." : "Your role cannot send invitations.";
  const stateLabel = serverState === "running" ? "Online" : serverState === "starting" ? "Starting" : serverState === "stopping" ? "Stopping" : serverState === "unknown" ? "Unknown" : "Stopped";

  useEffect(() => { if (confirming) confirmButton.current?.focus(); }, [confirming]);
  useEffect(() => {
    if (!inviteOpen || recipientState !== "idle") return;
    setRecipientState("loading");
    void loadInvitationRecipients().then((items) => {
      setRecipients(items);
      setRecipientState("ready");
    }).catch(() => setRecipientState("error"));
  }, [inviteOpen, recipientState]);

  const normalizedQuery = recipientQuery.trim().toLocaleLowerCase();
  const visibleRecipients = recipients.filter((recipient) => normalizedQuery === "" || recipient.displayName.toLocaleLowerCase().includes(normalizedQuery));
  const directCount = selectedRecipients.size;
  const sendDisabled = inviteRequest.state === "pending" || (audience === "direct" && directCount === 0);

  function confirmOperation() {
    if (!confirming) return;
    onOperation(confirming);
    setConfirming(null);
  }

  function toggleRecipient(id: string) {
    setSelectedRecipients((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submitInvitation() {
    setInviteRequest({ state: "pending", message: "Queueing Telegram invitation…" });
    try {
      await sendInvitation(game.id, world.id, audience, [...selectedRecipients]);
      setInviteRequest({ state: "success", message: audience === "broadcast" ? "Invitation queued for everyone." : `Invitation queued for ${directCount} ${directCount === 1 ? "player" : "players"}.` });
      setSelectedRecipients(new Set());
    } catch (inviteError) {
      setInviteRequest({ state: "error", message: inviteError instanceof Error ? inviteError.message : "The invitation could not be sent." });
    }
  }

  return <>
    <div className="page-heading"><div><h1>{world.displayName}</h1><p>{game.displayName} · {activeRelease ? `active release ${activeRelease}` : world.release.state === "unconfigured" ? "not adopted yet" : "release unavailable"}</p></div></div>
    {loadState === "error" && <div className="info-banner error-banner" role="alert"><strong>Current state could not be loaded.</strong><span>{error}</span><Button onClick={onRetry}>Try again</Button></div>}
    <section className="service-panel" aria-busy={loadState === "loading"}>
      <div className="service-summary">
        <span className={`service-icon ${serverState}`}><i /></span>
        <div><h2>{loadState === "loading" ? "Loading current state" : stateLabel}</h2><p>{host ? `${host.name} · ${host.state}` : loadState === "ready" ? "No compute host is currently available" : "Reading AWS control-plane state"}</p></div>
      </div>
      <div className="service-actions">
        <Button disabled={!canInvite} icon={<Icon name="users" />} onClick={() => { setInviteOpen((open) => !open); setInviteRequest({ state: "idle", message: "" }); }} title={inviteHint} variant="ghost">Invite players</Button>
        <Button disabled={controlDisabled} icon={<Icon name={sessionAction === "stop" ? "stop" : "play"} />} onClick={() => setConfirming(sessionAction)} title={controlsHint} variant={sessionAction === "stop" ? "danger" : "primary"}>{sessionAction === "stop" ? "Stop" : "Start"}</Button>
      </div>
    </section>
    {inviteOpen && <section aria-labelledby="invite-title" className="invite-panel">
      <header><div><h2 id="invite-title">Invite players</h2><p>{game.displayName} · {world.displayName}</p></div><Button aria-label="Close invitation panel" onClick={() => setInviteOpen(false)} variant="ghost">Close</Button></header>
      <div className="invite-body">
        <fieldset className="audience-options"><legend>Audience</legend>
          <label className={audience === "broadcast" ? "active" : ""}><input checked={audience === "broadcast"} name="invite-audience" onChange={() => setAudience("broadcast")} type="radio" /><span><strong>Everyone</strong><small>Group chats and people subscribed to invitations</small></span></label>
          <label className={audience === "direct" ? "active" : ""}><input checked={audience === "direct"} name="invite-audience" onChange={() => setAudience("direct")} type="radio" /><span><strong>Specific people</strong><small>Only selected people with direct invitations enabled</small></span></label>
        </fieldset>
        {audience === "direct" && <div className="recipient-picker">
          <div className="recipient-tools"><label><span>Find a player</span><input autoComplete="off" onChange={(event) => setRecipientQuery(event.target.value)} placeholder="Search by display name" type="search" value={recipientQuery} /></label><span>{directCount} selected</span></div>
          {recipientState === "loading" && <div className="recipient-state" role="status">Loading players…</div>}
          {recipientState === "error" && <div className="recipient-state error" role="alert"><span>Players could not be loaded.</span><Button onClick={() => setRecipientState("idle")} variant="ghost">Try again</Button></div>}
          {recipientState === "ready" && recipients.length === 0 && <div className="recipient-state">No other approved players yet.</div>}
          {recipientState === "ready" && recipients.length > 0 && <div className="recipient-list" role="group" aria-label="Players">
            <div className="recipient-list-toolbar"><span>{normalizedQuery ? `${visibleRecipients.length} matches` : `${recipients.length} available`}</span>{directCount > 0 && <button onClick={() => setSelectedRecipients(new Set())} type="button">Clear selection</button>}</div>
            <div className="recipient-scroll">{visibleRecipients.map((recipient) => <label key={recipient.id}><input checked={selectedRecipients.has(recipient.id)} onChange={() => toggleRecipient(recipient.id)} type="checkbox" /><span className="recipient-avatar">{initials(recipient.displayName)}</span><span><strong>{recipient.displayName}</strong><small>{selectedRecipients.has(recipient.id) ? "Selected" : "Direct invitation"}</small></span></label>)}
              {visibleRecipients.length === 0 && <div className="recipient-state">No players match “{recipientQuery.trim()}”.</div>}
            </div>
          </div>}
        </div>}
      </div>
      <footer><div><strong>{audience === "broadcast" ? "Invite everyone" : directCount === 0 ? "Choose at least one player" : `${directCount} ${directCount === 1 ? "player" : "players"} selected`}</strong><p>Delivery respects each player’s notification preferences.</p></div><Button disabled={sendDisabled} onClick={() => void submitInvitation()} variant="primary">{inviteRequest.state === "pending" ? "Sending…" : "Send invitation"}</Button></footer>
      {inviteRequest.state !== "idle" && <div aria-live="polite" className={`invite-feedback ${inviteRequest.state}`} role={inviteRequest.state === "error" ? "alert" : "status"}>{inviteRequest.message}</div>}
    </section>}
    {confirming && <section aria-labelledby="operation-confirmation-title" className="operation-confirmation" role="alertdialog">
      <div><h2 id="operation-confirmation-title">{confirming === "start" ? "Start a billed AWS session?" : "Save, back up and stop this session?"}</h2><p>{confirming === "start" ? `Spawnpoint will boot the host and start ${world.displayName}. Modded Minecraft may take several minutes to become healthy.` : "Spawnpoint will refuse while players are online, then save the world, create a verified backup and stop the host."}</p></div>
      <div><Button onClick={() => setConfirming(null)} variant="ghost">Cancel</Button><Button onClick={confirmOperation} ref={confirmButton} variant={confirming === "stop" ? "danger" : "primary"}>{confirming === "start" ? "Start session" : "Stop session"}</Button></div>
    </section>}
    {operationRequest.state !== "idle" && <div aria-live="polite" className={`operation-feedback ${operationRequest.state}`} role={operationRequest.state === "error" ? "alert" : "status"}>{operationRequest.message}</div>}
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

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}
