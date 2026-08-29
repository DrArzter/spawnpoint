import { Icon } from "../Icon";
import { Member } from "../model";
import { Button } from "./ui/Button";

const providerLabels: Record<Member["links"][number]["kind"], string> = {
  telegram: "Telegram", discord: "Discord", minecraft: "Minecraft", factorio: "Factorio", steam: "Steam", zerotier: "ZeroTier client",
};

export function LinkedAccountsEditor({ member, onClose }: { member: Member; onClose?: () => void }) {
  return <aside className="link-editor">
    <header><div><h2>Linked accounts</h2><p>Game identities, chat accounts and network clients</p></div>{onClose && <Button onClick={onClose} variant="ghost">Close</Button>}</header>
    <div className="linked-list">{member.links.length ? member.links.map((link) => <div key={link.id}><span className="link-kind"><Icon name="link" /><strong>{providerLabels[link.kind]}</strong></span><span>{link.value}<small>{link.verified ? "Verified" : "Pending verification"}</small></span></div>) : <p className="empty-links">No linked accounts yet.</p>}</div>
    <div className="link-editor-note"><strong>Link management is not connected yet</strong><p>Existing links come from Spawnpoint. Adding and removing accounts will be enabled after verification flows are implemented.</p></div>
  </aside>;
}
