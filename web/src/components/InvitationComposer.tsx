import { useEffect, useState } from "react";

import {
  loadInvitationHistory,
  loadInvitationRecipients,
  sendInvitation,
  type InvitationRecipient,
  type InvitationSummary,
} from "../auth";
import type { Game, World } from "../model";
import { Button } from "./ui/Button";

type Audience = "broadcast" | "direct";

export function InvitationComposer({ game, world, onClose }: { game: Game; world: World; onClose: () => void }) {
  const [audience, setAudience] = useState<Audience>("broadcast");
  const [recipients, setRecipients] = useState<InvitationRecipient[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [recipientState, setRecipientState] = useState<"loading" | "ready" | "error">("loading");
  const [history, setHistory] = useState<InvitationSummary[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const [request, setRequest] = useState<{ state: "idle" | "pending" | "success" | "error"; message: string }>({ state: "idle", message: "" });

  useEffect(() => {
    let active = true;
    void loadInvitationRecipients().then((items) => {
      if (!active) return;
      setRecipients(items);
      setRecipientState("ready");
    }).catch(() => { if (active) setRecipientState("error"); });
    void loadInvitationHistory(game.id, world.id).then((items) => {
      if (!active) return;
      setHistory(items);
      setHistoryState("ready");
    }).catch(() => { if (active) setHistoryState("error"); });
    return () => { active = false; };
  }, [game.id, world.id]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleRecipients = recipients.filter((recipient) => normalizedQuery === "" || recipient.displayName.toLocaleLowerCase().includes(normalizedQuery));
  const selectedCount = selected.size;
  const sendDisabled = request.state === "pending" || (audience === "direct" && selectedCount === 0);

  function toggleRecipient(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function refreshHistory() {
    setHistoryState("loading");
    try {
      setHistory(await loadInvitationHistory(game.id, world.id));
      setHistoryState("ready");
    } catch {
      setHistoryState("error");
    }
  }

  async function submit() {
    setRequest({ state: "pending", message: "Queueing Telegram invitation…" });
    try {
      await sendInvitation(game.id, world.id, audience, [...selected]);
      setRequest({ state: "success", message: audience === "broadcast" ? "Invitation accepted for delivery." : `Invitation accepted for ${selectedCount} ${selectedCount === 1 ? "player" : "players"}.` });
      setSelected(new Set());
      await refreshHistory();
    } catch (error) {
      setRequest({ state: "error", message: error instanceof Error ? error.message : "The invitation could not be sent." });
    }
  }

  return <section aria-labelledby="invite-title" className="invite-panel">
    <header><div><h2 id="invite-title">Invite players</h2><p>{game.displayName} · {world.displayName}</p></div><Button aria-label="Close invitation panel" onClick={onClose} variant="ghost">Close</Button></header>
    <div className="invite-body">
      <fieldset className="audience-options"><legend>Audience</legend>
        <label className={audience === "broadcast" ? "active" : ""}><input checked={audience === "broadcast"} name="invite-audience" onChange={() => setAudience("broadcast")} type="radio" /><span><strong>Everyone</strong><small>Group chats and people subscribed to invitations</small></span></label>
        <label className={audience === "direct" ? "active" : ""}><input checked={audience === "direct"} name="invite-audience" onChange={() => setAudience("direct")} type="radio" /><span><strong>Specific people</strong><small>Only selected people with direct invitations enabled</small></span></label>
      </fieldset>
      <div className="invite-detail">
        {audience === "broadcast" ? <div className="broadcast-summary"><strong>One message, no manual selection</strong><p>The invitation reaches configured group chats and people who opted into broadcast invitations. Your own private chat is excluded.</p></div> : <div className="recipient-picker">
          <div className="recipient-tools"><label><span>Find a player</span><input autoComplete="off" onChange={(event) => setQuery(event.target.value)} placeholder="Search by display name" type="search" value={query} /></label><span>{selectedCount} selected</span></div>
          {recipientState === "loading" && <div className="recipient-state" role="status">Loading players…</div>}
          {recipientState === "error" && <div className="recipient-state error" role="alert"><span>Players could not be loaded.</span><Button onClick={() => window.location.reload()} variant="ghost">Reload panel</Button></div>}
          {recipientState === "ready" && recipients.length === 0 && <div className="recipient-state">No other approved players yet.</div>}
          {recipientState === "ready" && recipients.length > 0 && <div className="recipient-list" role="group" aria-label="Players">
            <div className="recipient-list-toolbar"><span>{normalizedQuery ? `${visibleRecipients.length} matches` : `${recipients.length} available`}</span>{selectedCount > 0 && <button onClick={() => setSelected(new Set())} type="button">Clear selection</button>}</div>
            <div className="recipient-scroll">{visibleRecipients.map((recipient) => <label key={recipient.id}><input checked={selected.has(recipient.id)} onChange={() => toggleRecipient(recipient.id)} type="checkbox" /><span className="recipient-avatar">{initials(recipient.displayName)}</span><span><strong>{recipient.displayName}</strong><small>{selected.has(recipient.id) ? "Selected" : "Direct invitation"}</small></span></label>)}
              {visibleRecipients.length === 0 && <div className="recipient-state">No players match “{query.trim()}”.</div>}
            </div>
          </div>}
        </div>}
        <InvitationHistory history={history} state={historyState} onRefresh={() => void refreshHistory()} />
      </div>
    </div>
    <footer><div><strong>{audience === "broadcast" ? "Invite everyone" : selectedCount === 0 ? "Choose at least one player" : `${selectedCount} ${selectedCount === 1 ? "player" : "players"} selected`}</strong><p>Acceptance is recorded separately from the delivery result.</p></div><Button disabled={sendDisabled} onClick={() => void submit()} variant="primary">{request.state === "pending" ? "Sending…" : "Send invitation"}</Button></footer>
    {request.state !== "idle" && <div aria-live="polite" className={`invite-feedback ${request.state}`} role={request.state === "error" ? "alert" : "status"}>{request.message}</div>}
  </section>;
}

function InvitationHistory({ history, state, onRefresh }: { history: InvitationSummary[]; state: "loading" | "ready" | "error"; onRefresh: () => void }) {
  return <section className="invite-history" aria-labelledby="invite-history-title"><header><div><h3 id="invite-history-title">Recent invitations</h3><p>Your last attempts for this world</p></div><Button disabled={state === "loading"} onClick={onRefresh} variant="ghost">Refresh</Button></header>
    {state === "loading" && <div className="history-state" role="status">Reading delivery results…</div>}
    {state === "error" && <div className="history-state error" role="alert">Delivery history could not be loaded.</div>}
    {state === "ready" && history.length === 0 && <div className="history-state">No invitations sent yet.</div>}
    {state === "ready" && history.length > 0 && <ol>{history.slice(0, 3).map((item) => <li key={item.id}><span className={`delivery-status ${statusTone(item.status)}`}>{statusLabel(item.status)}</span><span>{item.audience === "broadcast" ? "Everyone" : `${item.recipientCount ?? 0} selected`}</span><span>{deliveryDetail(item)}</span><time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time></li>)}</ol>}
  </section>;
}

function statusLabel(status: InvitationSummary["status"]): string {
  const labels: Record<InvitationSummary["status"], string> = {
    READY: "Queued", DELIVERING: "Delivering", DELIVERED: "Delivered", PARTIAL: "Partial",
    FAILED: "Failed", NO_RECIPIENTS: "No recipients", PUBLISH_FAILED: "Queue failed",
  };
  return labels[status];
}

function statusTone(status: InvitationSummary["status"]): string {
  if (status === "DELIVERED") return "success";
  if (status === "FAILED" || status === "PUBLISH_FAILED") return "error";
  return "neutral";
}

function deliveryDetail(item: InvitationSummary): string {
  if (item.status === "READY" || item.status === "DELIVERING") return "Waiting for notifier";
  if (item.status === "NO_RECIPIENTS") return "Nobody was subscribed";
  if (item.status === "FAILED" && item.targetCount === 0) return "Delivery process failed";
  if (item.targetCount === null || item.successCount === null) return "No delivery result";
  return `${item.successCount}/${item.targetCount} delivered`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(date);
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}
