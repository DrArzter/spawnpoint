import { Avatar } from "../components/Avatar";
import { LinkedAccounts } from "../components/LinkedAccounts";
import { ActionRow, Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { Card, Details, Ghost } from "../components/ui/Surfaces";
import { plural } from "../lib/format";
import type { Member, Role } from "../model";
import { openInBrowser, ViewerProfile } from "../telegram";

export function ProfileScreen({ member, role, viewer, onSignOut }: { member: Member; role?: Role; viewer: ViewerProfile; onSignOut: () => void }) {
  return (
    <div className="page">
      <header className="profile-hero">
        <Avatar name={member.name} photoUrl={viewer.photoUrl} size="large" />
        <div>
          <h1>{member.name}</h1>
          <p>{viewer.username ? `@${viewer.username}` : "Spawnpoint identity"}</p>
        </div>
        <Chip icon="admin_panel_settings" tone="primary">{role?.name ?? "No role"}</Chip>
        <ActionRow>
          {viewer.inTelegram && <Button icon="open_in_new" onClick={openInBrowser} variant="outlined">Open in browser</Button>}
          <Button icon="logout" onClick={onSignOut} variant="text">Sign out</Button>
        </ActionRow>
      </header>
      <Card description="Display details come from the account you signed in with. An Owner manages roles and links." title="Identity">
        <Details items={[
          { label: "Display name", value: member.name },
          { label: "Profile photo", value: viewer.photoUrl ? <Avatar name={member.name} photoUrl={viewer.photoUrl} /> : <Ghost>Not set</Ghost> },
          { label: "Role", value: role?.name ?? "No role", hint: role ? plural(role.permissions.length, "permission") : undefined },
          {
            label: "Identity ID",
            value: member.id,
            mono: true,
            copy: member.id,
            explain: "Spawnpoint's own name for you. It does not change when you link another account or sign in through a different provider.",
          },
        ]} label="Identity details" />
      </Card>
      {/* The account id and the handle describe a linked account, not the
          identity that holds it, so they are read where that account is. */}
      <LinkedAccounts handles={{ telegram: viewer.username }} member={member} />
    </div>
  );
}
