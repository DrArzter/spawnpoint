import { Appearance } from "../components/Appearance";
import { Avatar } from "../components/Avatar";
import { LoginAccounts } from "../components/LoginAccounts";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { Card, Details, Ghost, PageHeader } from "../components/ui/Surfaces";
import { plural } from "../lib/format";
import type { Member, Role } from "../model";
import { openInBrowser, ThemePreference, ViewerProfile } from "../telegram";

type AppearanceControls = Readonly<{
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
  theme: "light" | "dark";
  accent: string;
  setAccent: (next: string) => void;
}>;

type ProfileScreenProps = Readonly<{
  appearance: AppearanceControls;
  member: Member;
  role?: Role;
  viewer: ViewerProfile;
  onSignOut: () => void;
}>;

export function ProfileScreen({ appearance, member, role, viewer, onSignOut }: ProfileScreenProps) {
  const provider = viewer.provider?.replaceAll(/[-_]/g, " ").replace(/^./, (letter) => letter.toUpperCase()) ?? "Unknown";
  return (
    <div className="page">
      <PageHeader
        actions={<>
          {viewer.inTelegram && <Button icon="open_in_new" onClick={openInBrowser} variant="outlined">Open in browser</Button>}
          <Button icon="logout" onClick={onSignOut} variant="text">Sign out</Button>
        </>}
        leading={<Avatar name={member.name} photoUrl={viewer.photoUrl} size="large" />}
        status={<Chip icon="admin_panel_settings" tone="primary">{role?.name ?? "No role"}</Chip>}
        subtitle={viewer.username ? `@${viewer.username}` : viewer.email ?? "Spawnpoint identity"}
        title={member.name}
      />
      <Card title="Identity">
        <Details items={[
          { label: "Display name", value: member.name },
          { label: "Profile photo", value: viewer.photoUrl ? <Avatar name={member.name} photoUrl={viewer.photoUrl} /> : <Ghost>Not set</Ghost> },
          { label: "Role", value: role?.name ?? "No role", hint: role ? plural(role.permissions.length, "permission") : undefined },
          { label: "Current sign-in", value: provider },
          ...(viewer.email ? [{ label: "Session email", value: viewer.email, copy: viewer.email, explain: "The address supplied by the sign-in method used for this session." }] : []),
          {
            label: "Identity ID",
            value: member.id,
            mono: true,
            copy: member.id,
            explain: "Spawnpoint's own name for you. It does not change when you link another account or sign in through a different provider.",
          },
        ]} label="Identity details" />
      </Card>
      <Appearance appearance={appearance} />
      <LoginAccounts displayName={member.name} />
    </div>
  );
}
