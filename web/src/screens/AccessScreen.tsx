import { useEffect, useState } from "react";

import { AccessCandidate, approveAccessCandidate, dismissAccessCandidate, loadAccessCandidates, loadAccessIdentities, loadAccessRoles, loadSubscriptions, SubscriptionState, updateIdentityRole, updateSubscriptions } from "../auth";
import { Avatar } from "../components/Avatar";
import { LinkedAccounts, providerLabel } from "../components/LinkedAccounts";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { Column, DataTable } from "../components/ui/DataTable";
import { Sheet } from "../components/ui/Dialog";
import { InlineSelect, Switch } from "../components/ui/Fields";
import { SkeletonRows } from "../components/ui/Skeleton";
import { useSnackbar } from "../components/ui/Snackbar";
import { Status } from "../components/ui/Status";
import { Banner, Card, Details, EmptyState, PageHeader } from "../components/ui/Surfaces";
import { Tabs } from "../components/ui/Tabs";
import { Icon } from "../icons";
import { formatDateTime } from "../lib/format";
import type { AccessTab, Game, LinkKind, Member, OwnerBootstrap, Role } from "../model";

const linkKinds: readonly LinkKind[] = ["telegram", "discord", "minecraft", "factorio", "steam", "zerotier"];

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
  const [roleState, setRoleState] = useState<"loading" | "ready" | "error">("loading");
  const [roleError, setRoleError] = useState("");

  async function loadRoles() {
    setRoleState("loading");
    setRoleError("");
    try {
      onRolesChange(await loadAccessRoles());
      setRoleState("ready");
    } catch (error) {
      setRoleError(error instanceof Error ? error.message : "Roles could not be loaded.");
      setRoleState("error");
    }
  }

  useEffect(() => { void loadRoles(); }, []);

  return (
    <div className="page">
      <PageHeader description="Who may open Spawnpoint, which role they hold, and which Telegram notifications reach you." title="Access" />
      <Tabs label="Access sections" onChange={onTabChange} options={[{ id: "users", label: "Users", icon: "group" }, { id: "roles", label: "Roles", icon: "admin_panel_settings", count: roles.length || undefined }, { id: "notifications", label: "My notifications", icon: "notifications" }]} value={tab} />
      <div aria-live="polite" role="tabpanel">
        {tab === "users" && <Users bootstrap={bootstrap} members={members} onChange={onMembersChange} roles={roles} rolesLoading={roleState === "loading"} />}
        {tab === "roles" && <Roles error={roleError} onRetry={() => void loadRoles()} roles={roles} state={roleState} />}
        {tab === "notifications" && <Notifications games={games} />}
      </div>
    </div>
  );
}

function Users({ bootstrap, members, roles, rolesLoading, onChange }: { bootstrap: OwnerBootstrap; members: Member[]; roles: Role[]; rolesLoading: boolean; onChange: (members: Member[]) => void }) {
  const notify = useSnackbar();
  const [managing, setManaging] = useState<string | null>(null);
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [candidates, setCandidates] = useState<AccessCandidate[]>([]);
  const [candidateRoles, setCandidateRoles] = useState<Record<string, string>>({});
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const managed = members.find((member) => member.id === managing);
  const owner = bootstrap.state === "claimed" ? members.find((member) => member.id === bootstrap.ownerId) : undefined;

  useEffect(() => {
    let active = true;
    Promise.all([loadAccessCandidates(), loadAccessIdentities()])
      .then(([candidateItems, identityItems]) => {
        if (!active) return;
        setCandidates(candidateItems);
        onChange(identityItems.map((identity) => ({
          id: identity.id,
          name: identity.displayName,
          roleId: identity.roleId,
          links: identity.links.filter((link) => (linkKinds as readonly string[]).includes(link.platform)).map((link) => ({ id: `${link.platform}-${link.value}`, kind: link.platform as LinkKind, value: link.value, verified: link.verified })),
        })));
        setState("ready");
      })
      .catch((cause: unknown) => { if (active) { setError(cause instanceof Error ? cause.message : "Access requests could not be loaded."); setState("error"); } });
    return () => { active = false; };
  }, []);

  async function changeRole(member: Member, roleId: string) {
    setWorking(member.id);
    try {
      await updateIdentityRole(member.id, roleId);
      onChange(members.map((item) => item.id === member.id ? { ...item, roleId } : item));
      notify({ tone: "success", message: `${member.name} is now ${roles.find((role) => role.id === roleId)?.name ?? roleId}.` });
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "The role could not be changed." });
    } finally {
      setWorking(null);
    }
  }

  async function approve(candidate: AccessCandidate) {
    const roleId = candidateRoles[candidate.platformUserId] ?? "viewer";
    setWorking(candidate.platformUserId);
    try {
      const identity = await approveAccessCandidate(candidate.platformUserId, roleId);
      setCandidates((current) => current.filter((item) => item.platformUserId !== candidate.platformUserId));
      onChange([...members, { id: identity.id, name: identity.displayName, roleId: identity.roleId, links: [{ id: `telegram-${candidate.platformUserId}`, kind: "telegram", value: candidate.platformUserId, verified: true }] }]);
      notify({ tone: "success", message: `${identity.displayName} approved as ${roles.find((role) => role.id === identity.roleId)?.name ?? identity.roleId}.` });
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "This Telegram account could not be approved." });
    } finally {
      setWorking(null);
    }
  }

  async function dismiss(candidate: AccessCandidate) {
    setWorking(candidate.platformUserId);
    try {
      await dismissAccessCandidate(candidate.platformUserId);
      setCandidates((current) => current.filter((item) => item.platformUserId !== candidate.platformUserId));
      notify({ message: `${candidate.displayName} dismissed.` });
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "This Telegram account could not be dismissed." });
    } finally {
      setWorking(null);
    }
  }

  const columns: Column<Member>[] = [
    { id: "user", label: "User", render: (member) => <span className="user-cell"><Avatar name={member.name} /><span><strong>{member.name}</strong><small className="mono">{member.id}</small></span></span> },
    { id: "links", label: "Linked accounts", render: (member) => member.links.length > 0 ? <span className="chip-row">{member.links.map((link) => <Chip icon={link.verified ? "verified" : "pending"} key={link.id} tone="tonal">{providerLabel(link.kind)}</Chip>)}</span> : <span className="ghost">None</span> },
    {
      id: "role",
      label: "Role",
      width: "180px",
      render: (member) => (
        <InlineSelect aria-label={`Role for ${member.name}`} disabled={rolesLoading || roles.length === 0 || working === member.id} onChange={(event) => void changeRole(member, event.target.value)} value={member.roleId}>
          {roles.length === 0 && <option value={member.roleId}>{member.roleId}</option>}
          {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
        </InlineSelect>
      ),
    },
    { id: "actions", label: "Actions", actions: true, render: (member) => <Button aria-expanded={member.id === managing} icon="link" onClick={() => setManaging(member.id)} size="small" variant="text">Linked accounts</Button> },
  ];

  return (
    <div className="page">
      {state === "error" && <Banner description={error} title="Access requests could not be loaded" tone="error" />}

      <Card
        actions={<Chip tone={candidates.length > 0 ? "warning" : "tonal"}>{candidates.length} waiting</Chip>}
        description="Signing in proves the Telegram account. Approval creates a Spawnpoint identity and assigns its first role."
        flush
        title="Access requests"
      >
        {state === "loading" && <SkeletonRows label="Loading access requests" rows={2} />}
        {state === "ready" && candidates.length === 0 && <EmptyState description="A visitor appears here after signing in and asking for access." icon="person_add" title="Nobody is waiting for review" />}
        {state === "ready" && candidates.map((candidate) => (
          <div className="request-row" key={candidate.platformUserId}>
            <Avatar name={candidate.displayName} photoUrl={candidate.photoUrl} size="large" className="avatar-request" />
            <span>
              <strong>{candidate.displayName}</strong>
              <small>{candidate.username ? `@${candidate.username} · ` : ""}{candidate.status === "REQUESTED" ? `Requested access ${formatDateTime(candidate.requestedAt)}` : `Signed in ${formatDateTime(candidate.lastSeenAt)}`}</small>
            </span>
            <InlineSelect aria-label={`Role for ${candidate.displayName}`} disabled={rolesLoading || roles.length === 0} onChange={(event) => setCandidateRoles((current) => ({ ...current, [candidate.platformUserId]: event.target.value }))} value={candidateRoles[candidate.platformUserId] ?? "viewer"}>
              {roles.length === 0 && <option value="viewer">Loading roles…</option>}
              {roles.filter((role) => role.id !== "owner").map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
            </InlineSelect>
            <div className="btn-row">
              <Button disabled={working === candidate.platformUserId} onClick={() => void dismiss(candidate)} variant="text">Dismiss</Button>
              <Button disabled={rolesLoading || roles.length === 0} loading={working === candidate.platformUserId} onClick={() => void approve(candidate)} variant="filled">Approve</Button>
            </div>
          </div>
        ))}
      </Card>

      <Card description="Every identity holds one role. Direct grants, when present, add single permissions on top." flush title="Identities">
        <DataTable columns={columns} label="Identities and roles" loading={state === "loading"} rowKey={(member) => member.id} rows={members} />
      </Card>

      <Card
        actions={<Status kind={bootstrap.state === "claimed" ? "ok" : "warning"} label={bootstrap.state === "claimed" ? "Complete" : "Action required"} />}
        description={bootstrap.state === "claimed" ? `${owner?.name ?? "The owner"} claimed the one-time setup with a verified Telegram account.` : `Sign in with the configured Telegram account (${bootstrap.telegramId}) to create the first Owner.`}
        title="Initial owner"
      >
        <Details items={[
          { label: "Telegram ID", value: bootstrap.telegramId, mono: true },
          { label: "Role", value: "Owner" },
          ...(bootstrap.state === "claimed" ? [{ label: "Claimed", value: bootstrap.claimedAt }] : []),
        ]} label="Initial owner" />
        <Button aria-expanded={showBootstrap} icon={showBootstrap ? "expand_less" : "expand_more"} onClick={() => setShowBootstrap((value) => !value)} size="small" variant="text">{showBootstrap ? "Hide setup steps" : "How the first Owner is set"}</Button>
        {showBootstrap && (
          <ol className="owner-steps">
            <li>Set the initial Owner Telegram ID in the deployment configuration.</li>
            <li>Sign in through Telegram with that exact account.</li>
            <li>Spawnpoint creates the Owner and closes the one-time setup for good.</li>
            <li>Add game and network accounts from the Owner profile once linking exists.</li>
          </ol>
        )}
      </Card>

      <Sheet description={managed ? `${managed.name} · ${roles.find((role) => role.id === managed.roleId)?.name ?? managed.roleId}` : undefined} onClose={() => setManaging(null)} open={managed !== undefined} title="Linked accounts">
        {managed && <LinkedAccounts member={managed} />}
      </Sheet>
    </div>
  );
}

function Roles({ roles, state, error, onRetry }: { roles: Role[]; state: "loading" | "ready" | "error"; error: string; onRetry: () => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const columns: Column<Role>[] = [
    { id: "role", label: "Role", width: "160px", render: (role) => <strong>{role.name}</strong> },
    { id: "description", label: "Description", render: (role) => role.description },
    {
      id: "permissions",
      label: "Permissions",
      render: (role) => (
        <span>
          <button aria-expanded={expanded === role.id} className="row-link" onClick={() => setExpanded(expanded === role.id ? null : role.id)} type="button">{role.permissions.length} permissions <Icon name={expanded === role.id ? "expand_less" : "expand_more"} size={16} /></button>
          {expanded === role.id && <span className="chip-row" style={{ marginTop: 8 }}>{role.permissions.map((permission) => <Chip key={permission} tone="tonal"><code>{permission}</code></Chip>)}</span>}
        </span>
      ),
    },
    { id: "type", label: "Type", width: "120px", render: (role) => role.system ? <Chip tone="tonal">Built-in</Chip> : <Chip tone="primary">Custom</Chip> },
  ];
  return (
    <div className="page">
      {state === "error" && <Banner actions={<Button onClick={onRetry} variant="text">Try again</Button>} description={error} title="Roles could not be loaded" tone="error" />}
      <Card description="Roles are defined in the access directory. Assign them on the Users tab; there is no role editor in the panel." flush title="Roles and permissions">
        <DataTable columns={columns} empty={<EmptyState description="The access directory returned no roles." icon="admin_panel_settings" title="No roles" />} label="Roles and permissions" loading={state === "loading"} rowKey={(role) => role.id} rows={roles} />
      </Card>
    </div>
  );
}

function Notifications({ games }: { games: readonly Game[] }) {
  const notify = useSnackbar();
  const [subscriptions, setSubscriptions] = useState<SubscriptionState>({});
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [error, setError] = useState("");

  async function reload() {
    setState("loading");
    setError("");
    try {
      setSubscriptions(await loadSubscriptions());
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your notification subscriptions could not be loaded.");
      setState("error");
    }
  }

  useEffect(() => { void reload(); }, []);

  async function toggle(id: string) {
    if (state === "loading" || state === "saving") return;
    const previous = subscriptions;
    const next = { ...subscriptions, [id]: !subscriptions[id] };
    setSubscriptions(next);
    setState("saving");
    try {
      setSubscriptions(await updateSubscriptions(next));
      setState("ready");
    } catch (cause) {
      setSubscriptions(previous);
      setState("ready");
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "Your notification subscriptions could not be saved." });
    }
  }

  const disabled = state === "loading" || state === "saving";
  const columns: Column<Game>[] = [
    { id: "game", label: "Game", render: (game) => <strong>{game.displayName}</strong> },
    { id: "started", label: "Session started", width: "180px", render: (game) => <label className="switch"><input aria-label={`${game.displayName} started`} checked={Boolean(subscriptions[`${game.id}.started`])} disabled={disabled} onChange={() => void toggle(`${game.id}.started`)} type="checkbox" /><span aria-hidden="true" className="switch-track" /></label> },
    { id: "stopped", label: "Session stopped", width: "180px", render: (game) => <label className="switch"><input aria-label={`${game.displayName} stopped`} checked={Boolean(subscriptions[`${game.id}.stopped`])} disabled={disabled} onChange={() => void toggle(`${game.id}.stopped`)} type="checkbox" /><span aria-hidden="true" className="switch-track" /></label> },
  ];

  return (
    <div className="page notification-groups">
      {state === "error" && <Banner actions={<Button onClick={() => void reload()} variant="text">Try again</Button>} description={error} title="Subscriptions are unavailable" tone="error" />}
      <Card actions={<span aria-live="polite" className="secondary" role="status">{state === "saving" ? "Saving…" : state === "ready" ? "Saved to your identity" : ""}</span>} description="Choose event types independently for each game. Preferences are stored with your Spawnpoint identity." flush title="Server events">
        <DataTable columns={columns} label="Server event subscriptions" loading={state === "loading"} rowKey={(game) => game.id} rows={games} />
      </Card>
      <Card description="Whether other players may notify you." title="Game invitations">
        {state === "loading" ? <SkeletonRows label="Loading invitation preferences" rows={2} /> : <>
          <Switch checked={Boolean(subscriptions["invitation.broadcast"])} disabled={disabled} label="Invitations sent to everyone" note="A player invited everyone to join a game" onChange={() => void toggle("invitation.broadcast")} />
          <Switch checked={Boolean(subscriptions["invitation.direct"])} disabled={disabled} label="Invitations sent directly to me" note="A player invited only selected people" onChange={() => void toggle("invitation.direct")} />
        </>}
      </Card>
      <Card flush>
        <div className="delivery-row">
          <div><h3>Delivery channel</h3><p>Telegram receives every category enabled above.</p></div>
          <Status kind="ok" label="Telegram linked" />
        </div>
      </Card>
    </div>
  );
}
