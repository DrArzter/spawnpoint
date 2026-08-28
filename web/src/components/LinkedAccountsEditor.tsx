import { FormEvent, useState } from "react";
import { Icon } from "../Icon";
import { LinkKind, Member } from "../model";
import { Button } from "./ui/Button";

const providers: readonly { id: LinkKind; label: string; placeholder: string }[] = [
  { id: "telegram", label: "Telegram", placeholder: "User ID" },
  { id: "discord", label: "Discord", placeholder: "Username or user ID" },
  { id: "minecraft", label: "Minecraft", placeholder: "Player name" },
  { id: "factorio", label: "Factorio", placeholder: "Player name" },
  { id: "steam", label: "Steam", placeholder: "Steam ID" },
  { id: "zerotier", label: "ZeroTier client", placeholder: "Node ID" },
];

export function LinkedAccountsEditor({ member, onChange, onClose }: { member: Member; onChange: (member: Member) => void; onClose?: () => void }) {
  const [kind, setKind] = useState<LinkKind>("discord");
  const [value, setValue] = useState("");
  const provider = providers.find((item) => item.id === kind) ?? providers[0];

  function add(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    onChange({ ...member, links: [...member.links, { id: `link-${Date.now()}`, kind, value: value.trim(), verified: false }] });
    setValue("");
  }

  return <aside className="link-editor">
    <header><div><h2>Linked accounts</h2><p>Game identities, chat accounts and network clients</p></div>{onClose && <Button onClick={onClose} variant="ghost">Close</Button>}</header>
    <div className="linked-list">{member.links.length ? member.links.map((link) => <div key={link.id}><span className="link-kind"><Icon name="link" /><strong>{providers.find((item) => item.id === link.kind)?.label ?? link.kind}</strong></span><span>{link.value}<small>{link.verified ? "Verified" : "Pending verification"}</small></span><Button aria-label={`Remove ${link.kind} link`} onClick={() => onChange({ ...member, links: member.links.filter((item) => item.id !== link.id) })} variant="ghost">Remove</Button></div>) : <p className="empty-links">No linked accounts yet.</p>}</div>
    <form onSubmit={add}><h3>Add account or client</h3><div><select aria-label="Account type" onChange={(event) => setKind(event.target.value as LinkKind)} value={kind}>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><input aria-label="Account identifier" onChange={(event) => setValue(event.target.value)} placeholder={provider.placeholder} value={value} /></div><Button icon={<Icon name="plus" />} type="submit">Add link</Button></form>
  </aside>;
}
