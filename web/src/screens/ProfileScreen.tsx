import { FormEvent, useState } from "react";
import { Avatar } from "../components/Avatar";
import { LinkedAccountsEditor } from "../components/LinkedAccountsEditor";
import { Member, Role } from "../model";
import { openInBrowser, ViewerProfile } from "../telegram";
import { Button } from "../components/ui/Button";
import { Icon } from "../Icon";
import { SectionHeader, Surface } from "../components/ui/Page";

export function ProfileScreen({ member, role, viewer, onChange, onSignOut }: { member: Member; role?: Role; viewer: ViewerProfile; onChange: (member: Member) => void; onSignOut: () => void }) {
  const [name, setName] = useState(member.name);
  const [saved, setSaved] = useState(false);
  function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    onChange({ ...member, name: name.trim() });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  return <>
    <div className="profile-heading">
      <Avatar name={member.name} photoUrl={viewer.photoUrl} size="large" />
      <div><h1>{member.name}</h1><p>{viewer.username ? `@${viewer.username}` : "Spawnpoint identity"}</p><span>{role?.name ?? "No role"}</span></div>
      <div className="profile-actions">{viewer.inTelegram && <Button className="profile-browser-button" icon={<Icon name="external" />} onClick={openInBrowser}>Open in browser</Button>}<Button onClick={onSignOut} variant="ghost">Sign out</Button></div>
    </div>
    <div className="profile-layout">
      <Surface className="profile-details">
        <SectionHeader description="Your display details inside Spawnpoint." title="Personal profile" />
        <form onSubmit={save}>
          <label>Display name<input onChange={(event) => setName(event.target.value)} value={name} /></label>
          <div className="profile-source"><span>Profile photo</span><strong>{viewer.photoUrl ? "Provided by Telegram" : "Initials fallback"}</strong></div>
          {viewer.telegramId && <div className="profile-source"><span>Telegram user ID</span><strong>{viewer.telegramId}</strong></div>}
          <footer><span aria-live="polite" role="status">{saved ? "Saved" : ""}</span><Button type="submit" variant="primary">Save profile</Button></footer>
        </form>
      </Surface>
      <LinkedAccountsEditor member={member} />
    </div>
  </>;
}
