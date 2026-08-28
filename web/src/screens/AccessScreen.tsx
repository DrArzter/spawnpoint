import { FormEvent, useEffect, useMemo, useState } from "react";
import { AccessCandidate, approveAccessCandidate, dismissAccessCandidate, loadAccessCandidates, loadAccessIdentities, updateIdentityRole } from "../auth";
import { Avatar } from "../components/Avatar";
import { LinkedAccountsEditor } from "../components/LinkedAccountsEditor";
import { Button } from "../components/ui/Button";
import { DataColumn, DataTable } from "../components/ui/DataTable";
import { Tabs } from "../components/ui/Tabs";
import { Icon } from "../Icon";
import { AccessTab, Game, Member, OwnerBootstrap, permissions, Role } from "../model";

type SubscriptionState = Record<string, boolean>;

const accessTabs = [
  { id: "users", label: "Users" },
  { id: "roles", label: "Roles" },
  { id: "notifications", label: "My notifications" },
] as const;

export function AccessScreen({ bootstrap, games, members, roles, tab, onMembersChange, onRolesChange, onTabChange }: {
  bootstrap: OwnerBootstrap;
  games: readonly Game[];
  members: Member[];
  roles: Role[];
  tab: AccessTab;
  onMembersChange: (members: Member[]) => void;
  onRolesChange: (roles: Role[]) => void;
  onTabChange: (tab: AccessTab) => void;
}) {
  const [creatingRole, setCreatingRole] = useState(false);
  return <>
    <div className="page-heading action-heading"><div><h1>Access</h1><p>Users, linked accounts, roles and your subscriptions</p></div>{tab === "roles" && <Button icon={<Icon name="plus" />} onClick={() => setCreatingRole(true)} variant="primary">Create role</Button>}</div>
    <Tabs label="Access settings" onChange={onTabChange} options={accessTabs} value={tab} />
    <div aria-live="polite" role="tabpanel">
      {tab === "users" && <Users bootstrap={bootstrap} members={members} roles={roles} onChange={onMembersChange} />}
      {tab === "roles" && <Roles creating={creatingRole} onCancel={() => setCreatingRole(false)} onCreate={(role) => { onRolesChange([...roles, role]); setCreatingRole(false); }} roles={roles} />}
      {tab === "notifications" && <Notifications games={games} />}
    </div>
  </>;
}

function Users({ bootstrap, members, roles, onChange }: { bootstrap: OwnerBootstrap; members: Member[]; roles: Role[]; onChange: (members: Member[]) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [candidates, setCandidates] = useState<AccessCandidate[]>([]);
  const [candidateRoles, setCandidateRoles] = useState<Record<string, string>>({});
  const [candidateState, setCandidateState] = useState<"loading" | "ready" | "error">("loading");
  const [candidateError, setCandidateError] = useState("");
  const editing = members.find((member) => member.id === editingId);
  const owner = bootstrap.state === "claimed" ? members.find((member) => member.id === bootstrap.ownerId) : undefined;
  const columns: DataColumn<Member>[] = [
    { id: "user", label: "User", width: "1.4fr", render: (member) => <span className="user-cell"><i>{member.name.slice(0, 2).toUpperCase()}</i><strong>{member.name}</strong></span> },
    { id: "links", label: "Linked accounts", width: "1.2fr", render: (member) => <span className="link-summary">{member.links.length ? member.links.map((link) => <small key={link.id}>{link.kind}</small>) : "None"}</span> },
    { id: "role", label: "Role", width: ".8fr", render: (member) => <select aria-label={`Role for ${member.name}`} onChange={(event) => void changeRole(member, event.target.value)} value={member.roleId}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select> },
    { id: "action", label: "Action", width: "100px", render: (member) => <Button aria-expanded={member.id === editingId} onClick={() => setEditingId(member.id === editingId ? null : member.id)} variant="ghost">Manage</Button> },
  ];

  useEffect(() => {
    let active = true;
    Promise.all([loadAccessCandidates(), loadAccessIdentities()])
      .then(([candidateItems, identityItems]) => { if (active) {
        setCandidates(candidateItems);
        onChange(identityItems.map((identity) => ({
          id: identity.id, name: identity.displayName, roleId: identity.roleId,
          links: identity.links.filter((link) => ["telegram", "discord", "minecraft", "factorio", "steam", "zerotier"].includes(link.platform)).map((link) => ({ id: `${link.platform}-${link.value}`, kind: link.platform as Member["links"][number]["kind"], value: link.value, verified: link.verified })),
        })));
        setCandidateState("ready");
      } })
      .catch((error: unknown) => { if (active) { setCandidateError(error instanceof Error ? error.message : "Access requests could not be loaded."); setCandidateState("error"); } });
    return () => { active = false; };
  }, []);

  async function changeRole(member: Member, roleId: string) {
    setCandidateError("");
    try {
      await updateIdentityRole(member.id, roleId);
      onChange(members.map((item) => item.id === member.id ? { ...item, roleId } : item));
    } catch (error) {
      setCandidateError(error instanceof Error ? error.message : "The role could not be changed.");
    }
  }

  async function approve(candidate: AccessCandidate) {
    setCandidateError("");
    try {
      const identity = await approveAccessCandidate(candidate.platformUserId, candidateRoles[candidate.platformUserId] ?? "viewer");
      setCandidates((current) => current.filter((item) => item.platformUserId !== candidate.platformUserId));
      onChange([...members, { id: identity.id, name: identity.displayName, roleId: identity.roleId, links: [{ id: `telegram-${candidate.platformUserId}`, kind: "telegram", value: candidate.platformUserId, verified: true }] }]);
    } catch (error) {
      setCandidateError(error instanceof Error ? error.message : "This Telegram account could not be approved.");
    }
  }

  async function dismiss(candidate: AccessCandidate) {
    setCandidateError("");
    try {
      await dismissAccessCandidate(candidate.platformUserId);
      setCandidates((current) => current.filter((item) => item.platformUserId !== candidate.platformUserId));
    } catch (error) {
      setCandidateError(error instanceof Error ? error.message : "This Telegram account could not be dismissed.");
    }
  }

  return <div className="users-layout">
    <section className="bootstrap-owner">
      <div className="bootstrap-summary">
        <div><h2>Initial owner</h2><p>{bootstrap.state === "claimed" ? `${owner?.name ?? "The owner"} claimed the one-time setup with a verified Telegram account.` : `Sign in with the configured Telegram account (${bootstrap.telegramId}) to create the first Owner.`}</p></div>
        <span className={`bootstrap-state ${bootstrap.state}`}>{bootstrap.state === "claimed" ? "Complete" : "Action required"}</span>
      </div>
      <dl><div><dt>Telegram ID</dt><dd>{bootstrap.telegramId}</dd></div><div><dt>Role</dt><dd>Owner</dd></div>{bootstrap.state === "claimed" && <div><dt>Claimed</dt><dd>{bootstrap.claimedAt}</dd></div>}</dl>
      <button aria-expanded={showBootstrap} className="bootstrap-explainer" onClick={() => setShowBootstrap((value) => !value)} type="button">{showBootstrap ? "Hide setup details" : "How the first Owner is set"}<Icon name="down" size={14} /></button>
      {showBootstrap && <ol className="bootstrap-steps"><li>Set the initial Owner Telegram ID in the deployment configuration.</li><li>Sign in through Telegram with that exact account.</li><li>Spawnpoint creates the Owner and permanently closes the one-time setup.</li><li>Add game and network accounts from the Owner profile.</li></ol>}
    </section>
    <section className="access-requests">
      <header><div><h2>Telegram access requests</h2><p>Signing in proves the Telegram account. Approval is what creates a Spawnpoint identity and role.</p></div><span>{candidates.length}</span></header>
      {candidateState === "loading" && <p className="candidate-empty">Loading access requests…</p>}
      {candidateState === "ready" && candidates.length === 0 && <p className="candidate-empty">No Telegram accounts are waiting for review.</p>}
      {candidates.map((candidate) => <article key={candidate.platformUserId}>
        <Avatar name={candidate.displayName} photoUrl={candidate.photoUrl ?? undefined} />
        <div><strong>{candidate.displayName}</strong><small>{candidate.username ? `@${candidate.username} · ` : ""}{candidate.status === "REQUESTED" ? "Requested access" : "Signed in"}</small></div>
        <select aria-label={`Role for ${candidate.displayName}`} onChange={(event) => setCandidateRoles((current) => ({ ...current, [candidate.platformUserId]: event.target.value }))} value={candidateRoles[candidate.platformUserId] ?? "viewer"}>{roles.filter((role) => role.id !== "owner").map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select>
        <div><Button onClick={() => void dismiss(candidate)} variant="ghost">Dismiss</Button><Button onClick={() => void approve(candidate)} variant="primary">Approve</Button></div>
      </article>)}
      {candidateError && <p className="candidate-error" role="alert">{candidateError}</p>}
    </section>
    <div className="users-columns"><DataTable columns={columns} label="Users and access roles" rowKey={(member) => member.id} rows={members} />{editing && <LinkedAccountsEditor member={editing} onChange={(next) => onChange(members.map((member) => member.id === next.id ? next : member))} onClose={() => setEditingId(null)} />}</div>
  </div>;
}

function Roles({ roles, creating, onCreate, onCancel }: { roles: Role[]; creating: boolean; onCreate: (role: Role) => void; onCancel: () => void }) {
  const columns: DataColumn<Role>[] = [
    { id: "role", label: "Role", width: "1fr", render: (role) => <strong>{role.name}</strong> },
    { id: "description", label: "Description", width: "2fr", render: (role) => role.description },
    { id: "permissions", label: "Permissions", width: ".7fr", render: (role) => role.permissions.length },
    { id: "type", label: "Type", width: ".7fr", render: (role) => <small className={`role-type ${role.system ? "built-in" : "custom"}`}>{role.system ? "Built-in" : "Custom"}</small> },
  ];
  return <div className="roles-layout"><DataTable columns={columns} label="Roles and permissions" rowKey={(role) => role.id} rows={roles} />{creating && <RoleForm onCancel={onCancel} onCreate={onCreate} />}</div>;
}

function RoleForm({ onCreate, onCancel }: { onCreate: (role: Role) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>(["status.read"]);
  const groups = useMemo(() => [...new Set(permissions.map((item) => item.group))], []);
  function submit(event: FormEvent) { event.preventDefault(); if (name.trim()) onCreate({ id: `custom-${Date.now()}`, name: name.trim(), description: "Custom role", permissions: selected }); }
  return <form className="role-editor" onSubmit={submit}><header><div><h2>Create role</h2><p>Choose exactly what this role can do.</p></div><Button onClick={onCancel} variant="ghost">Close</Button></header><label>Role name<input autoFocus onChange={(event) => setName(event.target.value)} placeholder="Moderator" required value={name} /></label><div className="permission-groups">{groups.map((group) => <fieldset key={group}><legend>{group}</legend>{permissions.filter((item) => item.group === group).map((permission) => <label key={permission.id}><input checked={selected.includes(permission.id)} onChange={() => setSelected((current) => current.includes(permission.id) ? current.filter((id) => id !== permission.id) : [...current, permission.id])} type="checkbox" /><span>{permission.label}<small>{permission.id}</small></span></label>)}</fieldset>)}</div><footer><Button onClick={onCancel} variant="ghost">Cancel</Button><Button type="submit" variant="primary">Create role</Button></footer></form>;
}

function Notifications({ games }: { games: readonly Game[] }) {
  const initial: SubscriptionState = { invitations_all: true, invitations_direct: true };
  for (const game of games) { initial[`${game.id}_started`] = game.id !== "zomboid"; initial[`${game.id}_stopped`] = game.id === "minecraft"; }
  const [subscriptions, setSubscriptions] = useState<SubscriptionState>(initial);
  const toggle = (id: string) => setSubscriptions((current) => ({ ...current, [id]: !current[id] }));
  const columns: DataColumn<Game>[] = [
    { id: "game", label: "Game", render: (game) => <strong>{game.displayName}</strong>, width: "1fr" },
    { id: "started", label: "Started", render: (game) => <Setting checked={subscriptions[`${game.id}_started`]} label={`${game.displayName} started`} onChange={() => toggle(`${game.id}_started`)} />, width: "110px" },
    { id: "stopped", label: "Stopped", render: (game) => <Setting checked={subscriptions[`${game.id}_stopped`]} label={`${game.displayName} stopped`} onChange={() => toggle(`${game.id}_stopped`)} />, width: "110px" },
  ];
  return <div className="notification-settings"><div className="preference-intro"><h2>Your subscriptions</h2><p>These preferences apply only to your identity and do not affect other players.</p></div><section><div className="setting-heading"><div><h2>Server events</h2><p>Choose event types independently for each game.</p></div></div><DataTable columns={columns} label="Server event subscriptions" rowKey={(game) => game.id} rows={games} /></section><section><div className="setting-heading"><div><h2>Game invitations</h2><p>Choose whether other players may notify you.</p></div></div><Setting checked={subscriptions.invitations_all} label="Invitations sent to everyone" note="A player invited everyone to join a game" onChange={() => toggle("invitations_all")} /><Setting checked={subscriptions.invitations_direct} label="Invitations sent directly to me" note="A player invited only selected people" onChange={() => toggle("invitations_direct")} /></section><section className="delivery-row"><div><h2>Delivery channel</h2><p>Telegram account linked to your identity</p></div><span>Connected</span></section></div>;
}

function Setting({ checked, label, note, onChange }: { checked: boolean; label: string; note?: string; onChange: () => void }) {
  return <label className="setting-row"><span><strong>{label}</strong>{note && <small>{note}</small>}</span><input aria-label={label} checked={checked} onChange={onChange} type="checkbox" /><i /></label>;
}
