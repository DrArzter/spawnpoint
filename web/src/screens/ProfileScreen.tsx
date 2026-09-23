import { Appearance } from "../components/Appearance";
import { Avatar } from "../components/Avatar";
import { LoginAccounts } from "../components/LoginAccounts";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { PageHeader } from "../components/ui/Surfaces";
import type { Member, Role } from "../model";
import { openInBrowser, ThemePreference, ViewerProfile } from "../telegram";

type AppearanceControls = Readonly<{
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => Promise<void>;
  theme: "light" | "dark";
  accent: string;
  setAccent: (next: string) => Promise<void>;
}>;

type ProfileScreenProps = Readonly<{
  appearance: AppearanceControls;
  member: Member;
  role?: Role;
  viewer: ViewerProfile;
  onSignOut: () => void;
}>;

export function ProfileScreen({ appearance, member, role, viewer, onSignOut }: ProfileScreenProps) {
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
      <Appearance appearance={appearance} />
      <LoginAccounts displayName={member.name} />
    </div>
  );
}
