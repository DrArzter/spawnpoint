import { useEffect, useState } from "react";

import { loadInvitationHistory, loadInvitationRecipients, sendInvitation, type InvitationRecipient, type InvitationSummary } from "../auth";
import { Timestamp } from "./ui/Timestamp";
import type { Game, World } from "../model";
import { Avatar } from "./Avatar";
import { Button } from "./ui/Button";
import { Chip } from "./ui/Chip";
import { Sheet } from "./ui/Dialog";
import { SearchField } from "./ui/Fields";
import { NoMatches } from "./ui/Filter";
import { SkeletonRows } from "./ui/Skeleton";
import { useSnackbar } from "./ui/Snackbar";
import { Status, StatusKind } from "./ui/Status";
import { Banner, EmptyState } from "./ui/Surfaces";

type Audience = "broadcast" | "direct";

export function InvitationSheet({ game, world, open, onClose }: { game: Game; world: World; open: boolean; onClose: () => void }) {
  const notify = useSnackbar();
  const [audience, setAudience] = useState<Audience>("broadcast");
  const [recipients, setRecipients] = useState<InvitationRecipient[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [recipientState, setRecipientState] = useState<"loading" | "ready" | "error">("loading");
  const [history, setHistory] = useState<InvitationSummary[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setAudience("broadcast");
    setSelected(new Set());
    setQuery("");
    setRecipientState("loading");
    setHistoryState("loading");
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
  }, [open, game.id, world.id]);

  const needle = query.trim().toLocaleLowerCase();
  const visible = recipients.filter((recipient) => needle === "" || recipient.displayName.toLocaleLowerCase().includes(needle));
  const reachable = recipients.filter((recipient) => recipient.delivery === "ready").length;
  const sendDisabled = sending || (audience === "direct" && selected.size === 0);

  function toggle(recipient: InvitationRecipient) {
    if (recipient.delivery !== "ready") return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(recipient.id)) next.delete(recipient.id); else next.add(recipient.id);
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
    setSending(true);
    try {
      await sendInvitation(game.id, world.id, audience, [...selected]);
      notify({ tone: "success", message: audience === "broadcast" ? "Invitation accepted for delivery to everyone." : `Invitation accepted for ${selected.size} ${selected.size === 1 ? "player" : "players"}.` });
      setSelected(new Set());
      await refreshHistory();
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "The invitation could not be sent." });
    } finally {
      setSending(false);
    }
  }

  return (
    <Sheet
      description={`${game.displayName} · ${world.displayName}${world.connectionAddress ? ` · ${world.connectionAddress}` : ""}`}
      footer={<>
        <p>{audience === "broadcast" ? "One Telegram message to group chats and subscribers." : selected.size === 0 ? "Choose at least one player." : `${selected.size} ${selected.size === 1 ? "player" : "players"} selected.`}</p>
        <Button disabled={sendDisabled} icon="send" loading={sending} onClick={() => void submit()} variant="filled">Send invitation</Button>
      </>}
      onClose={onClose}
      open={open}
      title="Invite players"
    >
      <fieldset className="audience">
        <legend>Audience</legend>
        <label className="audience-option">
          <input checked={audience === "broadcast"} name="invite-audience" onChange={() => setAudience("broadcast")} type="radio" />
          <span><strong>Everyone</strong><small>Group chats and people subscribed to broadcast invitations. Your own chat is excluded.</small></span>
        </label>
        <label className="audience-option">
          <input checked={audience === "direct"} name="invite-audience" onChange={() => setAudience("direct")} type="radio" />
          <span><strong>Specific people</strong><small>Only the selected people, if they allow direct invitations.</small></span>
        </label>
      </fieldset>

      {audience === "direct" && (
        <section aria-label="Players" className="recipients">
          <SearchField autoComplete="off" label="Find a player" onChange={(event) => setQuery(event.target.value)} placeholder="Search by display name" value={query} />
          <p className="secondary recipients-summary">{needle ? `${visible.length} matches` : `${reachable} reachable of ${recipients.length}`}{selected.size > 0 && <Button onClick={() => setSelected(new Set())} size="small" variant="text">Clear selection</Button>}</p>
          {recipientState === "loading" && <SkeletonRows label="Loading approved players" rows={3} />}
          {recipientState === "error" && <Banner actions={<Button onClick={() => window.location.reload()} variant="text">Reload</Button>} title="Players could not be loaded" tone="error" />}
          {recipientState === "ready" && recipients.length === 0 && <EmptyState description="Approve another player in Access before sending a direct invitation." icon="group" title="No other approved players" />}
          {recipientState === "ready" && recipients.length > 0 && visible.length === 0 && <NoMatches filter={{ query, clear: () => setQuery("") }} icon="group" noun="players" />}
          {recipientState === "ready" && visible.length > 0 && (
            <ul className="recipient-list">
              {visible.map((recipient) => {
                const ready = recipient.delivery === "ready";
                return (
                  <li key={recipient.id}>
                    <label className={ready ? "recipient" : "recipient recipient-unavailable"}>
                      <input checked={selected.has(recipient.id)} disabled={!ready} onChange={() => toggle(recipient)} type="checkbox" />
                      <Avatar name={recipient.displayName} />
                      <span><strong>{recipient.displayName}</strong><small>{deliveryLabel(recipient)}</small></span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="invite-history-title" className="invite-history">
        <header>
          <h3 id="invite-history-title">Recent invitations</h3>
          <Button disabled={historyState === "loading"} icon="refresh" onClick={() => void refreshHistory()} size="small" variant="text">Refresh</Button>
        </header>
        {historyState === "loading" && <SkeletonRows label="Loading recent invitation results" rows={2} />}
        {historyState === "error" && <Banner title="Delivery history could not be loaded" tone="error" />}
        {historyState === "ready" && history.length === 0 && <p className="secondary">No invitations sent for this world yet.</p>}
        {historyState === "ready" && history.length > 0 && (
          <ul className="history-list">
            {history.slice(0, 5).map((item) => (
              <li key={item.id}>
                <Status kind={statusKind(item.status)} label={statusLabel(item.status)} />
                <span>{item.audience === "broadcast" ? <Chip tone="tonal">Everyone</Chip> : <Chip tone="tonal">{item.recipientCount ?? 0} selected</Chip>}</span>
                <span className="secondary history-detail">{deliveryDetail(item)}</span>
                <Timestamp className="secondary" value={item.createdAt} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </Sheet>
  );
}

function statusLabel(status: InvitationSummary["status"]): string {
  const labels: Record<InvitationSummary["status"], string> = {
    READY: "Queued", DELIVERING: "Delivering", DELIVERED: "Delivered", PARTIAL: "Partial",
    FAILED: "Failed", NO_RECIPIENTS: "No recipients", PUBLISH_FAILED: "Queue failed",
  };
  return labels[status];
}

function statusKind(status: InvitationSummary["status"]): StatusKind {
  if (status === "DELIVERED") return "ok";
  if (status === "FAILED" || status === "PUBLISH_FAILED") return "error";
  if (status === "PARTIAL") return "warning";
  if (status === "READY" || status === "DELIVERING") return "progress";
  return "off";
}

function deliveryDetail(item: InvitationSummary): string {
  if (item.status === "READY" || item.status === "DELIVERING") return "Waiting for the notifier";
  if (item.status === "NO_RECIPIENTS") return "Nobody was subscribed";
  if (item.status === "FAILED" && item.targetCount === 0) return "Delivery process failed";
  if (item.targetCount === null || item.successCount === null) return "No delivery result";
  return `${item.successCount}/${item.targetCount} delivered`;
}

function deliveryLabel(recipient: InvitationRecipient): string {
  if (recipient.delivery === "ready") return "Accepts direct invitations";
  if (recipient.delivery === "notifications_off") return "Direct invitations turned off";
  return "Must open the bot privately first";
}
