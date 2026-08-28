import { Icon } from "../Icon";
import { useState } from "react";
import { Game, Member, ServerState, World } from "../model";
import { Button } from "../components/ui/Button";

export function DashboardScreen({ game, world, members, serverState, onToggle, onInvite }: {
  game: Game; world: World; members: Member[]; serverState: ServerState; onToggle: () => void; onInvite: (count: number) => void;
}) {
  const [inviting, setInviting] = useState(false);
  const [audience, setAudience] = useState<"everyone" | "specific">("everyone");
  const [selected, setSelected] = useState<number[]>([]);

  function sendInvitation() {
    const count = audience === "everyone" ? members.length : selected.length;
    if (!count) return;
    onInvite(count);
    setInviting(false);
  }

  return <>
    <div className="page-heading"><div><h1>{world.title}</h1><p>{game.title} · release {world.release}</p></div></div>
    <section className="service-panel">
      <div className="service-summary">
        <span className={`service-icon ${serverState}`}><i /></span>
        <div><h2>{serverState === "running" ? "Online" : serverState === "starting" ? "Starting" : "Stopped"}</h2><p>{serverState === "running" ? "172.29.23.24:25565" : "Compute is not running"}</p></div>
      </div>
      <div className="service-actions">
        <Button icon={<Icon name="users" />} onClick={() => setInviting(!inviting)} variant="ghost">Invite players</Button>
        <Button disabled={!world.ready || serverState === "starting"} icon={<Icon name={serverState === "running" ? "stop" : "play"} />} onClick={onToggle} variant={serverState === "running" ? "danger" : "primary"}>{serverState === "running" ? "Stop" : serverState === "starting" ? "Starting…" : "Start"}</Button>
      </div>
    </section>
    {inviting && <section className="invite-panel">
      <header><div><h2>Invite players</h2><p>Send a Telegram invitation to play {game.title}.</p></div><Button onClick={() => setInviting(false)} variant="ghost">Close</Button></header>
      <div className="audience-options"><button aria-pressed={audience === "everyone"} className={audience === "everyone" ? "active" : ""} onClick={() => setAudience("everyone")} type="button">Everyone</button><button aria-pressed={audience === "specific"} className={audience === "specific" ? "active" : ""} onClick={() => setAudience("specific")} type="button">Specific players</button></div>
      {audience === "specific" && <div className="recipient-list">{members.map((member) => <label key={member.id}><input checked={selected.includes(member.id)} onChange={() => setSelected((current) => current.includes(member.id) ? current.filter((id) => id !== member.id) : [...current, member.id])} type="checkbox" /><span>{member.name}<small>{member.links.some((link) => link.kind === "telegram") ? "Telegram connected" : "No delivery channel"}</small></span></label>)}</div>}
      <footer><p>{audience === "everyone" ? `${members.length} eligible players` : `${selected.length} selected`}</p><Button disabled={audience === "specific" && selected.length === 0} onClick={sendInvitation} variant="primary">Send invitation</Button></footer>
    </section>}
    <section className="summary-grid">
      <Stat label="Players" value={serverState === "running" ? "1 / 20" : "—"} detail="Current session" />
      <Stat label="CPU" value={serverState === "running" ? "18.7%" : "—"} detail="One core = 100%" />
      <Stat label="Memory" value={serverState === "running" ? "5.86 GiB" : "—"} detail="8 GiB instance" />
      <Stat label="Response" value={serverState === "running" ? "1.6 ms" : "—"} detail="Private network" />
    </section>
    <section className="data-section"><div className="section-title"><div><h2>Recent activity</h2><p>Operations for this world</p></div></div>
      <div className="activity-table">
        <div><span className="event-dot success" /><strong>Backup verified</strong><span>world-20260826T213152Z</span><time>Yesterday</time></div>
        <div><span className="event-dot" /><strong>Release promoted</strong><span>1.0 → 1.1</span><time>Yesterday</time></div>
        <div><span className="event-dot" /><strong>Server stopped</strong><span>Idle watchdog</span><time>2 days ago</time></div>
      </div>
    </section>
  </>;
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="stat"><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}
