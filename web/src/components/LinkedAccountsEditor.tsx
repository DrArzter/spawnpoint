import { Icon } from "../Icon";
import { Member } from "../model";
import { Button } from "./ui/Button";
import { EmptyState, Notice, SectionHeader, Surface } from "./ui/Page";

const providerLabels: Record<Member["links"][number]["kind"], string> = {
  telegram: "Telegram", discord: "Discord", minecraft: "Minecraft", factorio: "Factorio", steam: "Steam", zerotier: "ZeroTier client",
};

export function LinkedAccountsEditor({ member, onClose }: { member: Member; onClose?: () => void }) {
  return <Surface as="aside" className="link-editor">
    <SectionHeader actions={onClose && <Button onClick={onClose} variant="ghost">Close</Button>} description="Game identities, chat accounts and network clients" title="Linked accounts" />
    <div className="linked-list">{member.links.length ? member.links.map((link) => <div key={link.id}><span className="link-kind"><Icon name="link" /><strong>{providerLabels[link.kind]}</strong></span><span>{link.value}<small>{link.verified ? "Verified" : "Pending verification"}</small></span></div>) : <EmptyState description="Link a supported account after its verification flow is available." icon="link" title="No linked accounts yet" />}</div>
    <Notice description="Existing links come from Spawnpoint. Adding and removing accounts will be enabled after verification flows are implemented." title="Link management is not connected yet" />
  </Surface>;
}
