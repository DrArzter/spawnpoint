import { Icon, IconName } from "../icons";
import type { LinkKind, Member } from "../model";
import { Chip } from "./ui/Chip";
import { Banner, Card, EmptyState } from "./ui/Surfaces";

const providers: Record<LinkKind, { label: string; icon: IconName }> = {
  telegram: { label: "Telegram", icon: "send" },
  discord: { label: "Discord", icon: "group" },
  minecraft: { label: "Minecraft", icon: "public" },
  factorio: { label: "Factorio", icon: "public" },
  steam: { label: "Steam", icon: "sports_esports" },
  zerotier: { label: "ZeroTier client", icon: "dns" },
};

export function providerLabel(kind: LinkKind): string {
  return providers[kind].label;
}

export function LinkedAccounts({ member }: { member: Member }) {
  return (
    <Card description="Game identities, chat accounts and network clients tied to this Spawnpoint identity." title="Linked accounts">
      {member.links.length === 0 && <EmptyState description="Links appear once their verification flow exists." icon="link" title="No linked accounts" />}
      {member.links.length > 0 && (
        <ul className="linked-list">
          {member.links.map((link) => (
            <li className="linked-row" key={link.id}>
              <span aria-hidden="true" className="link-icon"><Icon name={providers[link.kind].icon} size={20} /></span>
              <span>
                <strong>{providers[link.kind].label}</strong>
                <code>{link.value}</code>
              </span>
              {link.verified ? <Chip icon="verified" tone="success">Verified</Chip> : <Chip icon="pending" tone="warning">Pending verification</Chip>}
            </li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: 16 }}>
        <Banner description="Existing links come from Spawnpoint. Adding and removing accounts arrives with the verification flows." title="Link management is not connected yet" />
      </div>
    </Card>
  );
}
