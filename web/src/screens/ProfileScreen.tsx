import { Avatar } from "../components/Avatar";
import { LinkedAccounts } from "../components/LinkedAccounts";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { Card, Details } from "../components/ui/Surfaces";
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
        <div className="btn-row">
          {viewer.inTelegram && <Button icon="open_in_new" onClick={openInBrowser} variant="outlined">Open in browser</Button>}
          <Button icon="logout" onClick={onSignOut} variant="text">Sign out</Button>
        </div>
      </header>
      <Card description="Display details come from Telegram at sign-in. Roles and linked accounts are managed by an Owner." title="Identity">
        <Details items={[
          { label: "Display name", value: member.name, hint: "Provided by Telegram" },
          { label: "Telegram user ID", value: viewer.telegramId ?? "Unknown", mono: true, copy: viewer.telegramId },
          { label: "Username", value: viewer.username ? `@${viewer.username}` : "Not set" },
          { label: "Profile photo", value: viewer.photoUrl ? "Provided by Telegram" : "Initials" },
          { label: "Role", value: role?.name ?? "No role", hint: role ? `${role.permissions.length} permissions` : undefined },
          { label: "Identity ID", value: member.id, mono: true, copy: member.id },
        ]} label="Identity details" />
      </Card>
      <LinkedAccounts member={member} />
    </div>
  );
}
