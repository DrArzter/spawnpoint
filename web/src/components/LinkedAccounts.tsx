import type { ReactNode } from "react";

import { Icon, IconName } from "../icons";
import type { LinkKind, Member } from "../model";
import { Chip } from "./ui/Chip";
import { Card, EmptyState, NotConnected } from "./ui/Surfaces";

// Three different things were being shown as one undifferentiated list, which
// is why nobody could say what a linked Factorio account was for. A link either
// proves who you are, names you inside a game, or admits a device to the
// network, and the grouping says which.
type LinkPurpose = "sign-in" | "game" | "network";

// The heading is the whole of it. Each one carried a sentence restating what
// its own title already says, above a list of one or two rows.
const purposes: readonly { id: LinkPurpose; title: string }[] = [
  { id: "sign-in", title: "Sign-in" },
  { id: "game", title: "Game identity" },
  { id: "network", title: "Network" },
];

const providers: Record<LinkKind, { label: string; icon: IconName; purpose: LinkPurpose }> = {
  telegram: { label: "Telegram", icon: "send", purpose: "sign-in" },
  discord: { label: "Discord", icon: "group", purpose: "sign-in" },
  minecraft: { label: "Minecraft", icon: "public", purpose: "game" },
  factorio: { label: "Factorio", icon: "public", purpose: "game" },
  steam: { label: "Steam", icon: "sports_esports", purpose: "game" },
  zerotier: { label: "ZeroTier client", icon: "dns", purpose: "network" },
};

export function providerLabel(kind: LinkKind): string {
  return providers[kind].label;
}

// `handles` carries the display name an account is known by on its own
// platform, which only the person themselves is shown.
export function LinkedAccounts({ member, handles, bare = false }: { member: Member; handles?: Partial<Record<LinkKind, string>>; bare?: boolean }) {
  // Inside a sheet the sheet is already titled, and each group now carries its
  // own heading, so a card around it would say "Linked accounts" twice.
  const Frame = bare
    ? ({ children }: { children: ReactNode }) => <div className="page">{children}</div>
    : ({ children }: { children: ReactNode }) => <Card title="Linked accounts">{children}</Card>;
  return (
    <Frame>
      <NotConnected description="Existing links come from Spawnpoint." inline title="Adding and removing accounts is not connected yet." />
      {member.links.length === 0 && <EmptyState description="Links appear once their verification flow exists." icon="link" title="No linked accounts" />}
      {purposes.map((purpose) => {
        const links = member.links.filter((link) => providers[link.kind].purpose === purpose.id);
        if (links.length === 0) return null;
        return (
          <section className="linked-group" key={purpose.id}>
            <h3>{purpose.title}</h3>
            <ul className="linked-list">
              {links.map((link) => (
                <li className="linked-row" key={link.id}>
                  <span aria-hidden="true" className="link-icon"><Icon name={providers[link.kind].icon} size={20} /></span>
                  <span>
                    <strong>{providers[link.kind].label}{handles?.[link.kind] && <small className="handle">@{handles[link.kind]}</small>}</strong>
                    <code>{link.value}</code>
                  </span>
                  {link.verified ? <Chip icon="verified" tone="success">Verified</Chip> : <Chip icon="pending" tone="warning">Pending verification</Chip>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

    </Frame>
  );
}
