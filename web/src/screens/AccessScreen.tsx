import { useEffect, useState } from "react";

import type { ApiFailureKind } from "../api/contract";
import { failureKind } from "../api/contract";
import { AccessCandidate, approveAccessCandidate, dismissAccessCandidate, loadAccessCandidates, loadAccessIdentities, loadAccessRoles, loadSubscriptions, SubscriptionState, updateIdentityRole, updateSubscriptions } from "../auth";
import { Avatar } from "../components/Avatar";
import { LinkedAccounts } from "../components/LinkedAccounts";
import { ActionRow, Button } from "../components/ui/Button";
import { Column, DataTable } from "../components/ui/DataTable";
import { Sheet } from "../components/ui/Dialog";
import { InlineSelect, Switch } from "../components/ui/Fields";
import { FilterBar, NoMatches, useFilter } from "../components/ui/Filter";
import { SkeletonRows } from "../components/ui/Skeleton";
import { useSnackbar } from "../components/ui/Snackbar";
import { Status } from "../components/ui/Status";
import { Banner, Card, Details, EmptyState, Ghost, NotConnected } from "../components/ui/Surfaces";
import { Tabs } from "../components/ui/Tabs";
import { Icon } from "../icons";
import { formatDateTime, plural } from "../lib/format";
import { describePermission } from "../lib/permissions";
import type { AccessTab, Game, LinkKind, Member, OwnerBootstrap, Role } from "../model";

const linkKinds: readonly LinkKind[] = ["telegram", "email", "discord", "minecraft", "factorio", "steam", "zerotier"];

// The platform an account signs in through, as the panel names its links. A
// password account is known by its email, not by its credential id.
function linkKindFor(platform: string): LinkKind | null {
  if (platform === "password") return "email";
  return (linkKinds as readonly string[]).includes(platform) ? platform as LinkKind : null;
}

function linkFor(platform: string, value: string, handle: string | null, verified: boolean): Member["links"][number] | null {
  const kind = linkKindFor(platform);
  if (kind === null) return null;
  return { id: `${kind}-${value}`, kind, value: kind === "email" ? handle ?? value : value, verified };
}

// How a waiting account introduces itself: its Telegram handle, or its email.
function candidateAccount(candidate: AccessCandidate): string {
  if (candidate.platform === "password") return candidate.email ?? "Email account";
  return candidate.username ? `@${candidate.username}` : "Telegram account";
}

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
  const [roleKind, setRoleKind] = useState<ApiFailureKind>("failed");

  async function loadRoles() {
    setRoleState("loading");
    setRoleError("");
    try {
      onRolesChange(await loadAccessRoles());
      setRoleState("ready");
    } catch (error) {
      setRoleError(error instanceof Error ? error.message : "Roles could not be loaded.");
      setRoleKind(failureKind(error));
      setRoleState("error");
    }
  }

  useEffect(() => { void loadRoles(); }, []);

  return (
    <div className="page">
      <h1 className="visually-hidden">Access</h1>
      <Tabs label="Access sections" onChange={onTabChange} options={[{ id: "users", label: "Users", icon: "group" }, { id: "roles", label: "Roles", icon: "admin_panel_settings", count: roles.length || undefined }, { id: "notifications", label: "My notifications", icon: "notifications" }]} value={tab} />
      <div aria-live="polite" role="tabpanel">
        {tab === "users" && <Users bootstrap={bootstrap} members={members} onChange={onMembersChange} roles={roles} rolesLoading={roleState === "loading"} />}
        {tab === "roles" && <Roles error={roleError} failure={roleKind} onRetry={() => void loadRoles()} roles={roles} state={roleState} />}
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
          links: identity.links.flatMap((link) => {
            const mapped = linkFor(link.platform, link.value, link.handle, link.verified);
            return mapped === null ? [] : [mapped];
          }),
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
      const identity = await approveAccessCandidate(candidate.platform, candidate.platformUserId, roleId);
      setCandidates((current) => current.filter((item) => item.platformUserId !== candidate.platformUserId));
      const link = linkFor(candidate.platform, candidate.platformUserId, candidate.username ?? candidate.email, candidate.platform !== "password");
      onChange([...members, { id: identity.id, name: identity.displayName, roleId: identity.roleId, links: link === null ? [] : [link] }]);
      notify({ tone: "success", message: `${identity.displayName} approved as ${roles.find((role) => role.id === identity.roleId)?.name ?? identity.roleId}.` });
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "This account could not be approved." });
    } finally {
      setWorking(null);
    }
  }

  async function dismiss(candidate: AccessCandidate) {
    setWorking(candidate.platformUserId);
    try {
      await dismissAccessCandidate(candidate.platform, candidate.platformUserId);
      setCandidates((current) => current.filter((item) => item.platformUserId !== candidate.platformUserId));
      notify({ message: `${candidate.displayName} dismissed.` });
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "This account could not be dismissed." });
    } finally {
      setWorking(null);
    }
  }

  const candidateColumns: Column<AccessCandidate>[] = [
    {
      id: "user",
      label: "User",
      render: (candidate) => (
        <span className="user-cell">
          <Avatar name={candidate.displayName} photoUrl={candidate.photoUrl} />
          <span>
            <strong>{candidate.displayName}</strong>
            <small>{candidateAccount(candidate)} · {candidate.status === "REQUESTED" ? "Requested access " : "Signed in "}{formatDateTime(candidate.status === "REQUESTED" ? candidate.requestedAt : candidate.lastSeenAt)}</small>
          </span>
        </span>
      ),
    },
    {
      id: "role",
      label: "Role",
      align: "end",
      width: "180px",
      render: (candidate) => (
        <InlineSelect aria-label={`Role for ${candidate.displayName}`} disabled={rolesLoading || roles.length === 0} onChange={(event) => setCandidateRoles((current) => ({ ...current, [candidate.platformUserId]: event.target.value }))} value={candidateRoles[candidate.platformUserId] ?? "viewer"}>
          {roles.length === 0 && <option value="viewer">Loading roles…</option>}
          {roles.filter((role) => role.id !== "owner").map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
        </InlineSelect>
      ),
    },
    {
      id: "actions",
      label: "Actions",
      actions: true,
      render: (candidate) => (
        <ActionRow>
          <Button disabled={working === candidate.platformUserId} onClick={() => void dismiss(candidate)} size="small" variant="outlined">Dismiss</Button>
          <Button disabled={rolesLoading || roles.length === 0} loading={working === candidate.platformUserId} onClick={() => void approve(candidate)} size="small" variant="filled">Approve</Button>
        </ActionRow>
      ),
    },
  ];

  const columns: Column<Member>[] = [
    // The identity id is not shown. It is an internal handle, and a table is
    // read to tell one person from another, which their name already does.
    { id: "user", label: "User", render: (member) => <span className="user-cell"><Avatar name={member.name} /><strong>{member.name}</strong></span> },
    {
      id: "role",
      label: "Role",
      // Right-aligned against the actions beside it, so the control that changes
      // a role sits next to the one that opens their accounts rather than
      // stranded in the middle of the row.
      align: "end",
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

      {/* The same shape as Identities, because it is the same thing: people and
          what may be done about them. A second rhythm on one screen made two
          lists of the same rows look like two different kinds of object. */}
      <Card flush title="Access requests">
        <DataTable
          columns={candidateColumns}
          hideHeader
          empty={<EmptyState description="Somebody appears here after signing in, or creating an account, and asking for access." icon="person_add" title="Nobody is waiting for review" />}
          label="Access requests"
          loading={state === "loading"}
          loadingRows={2}
          rowKey={(candidate) => `${candidate.platform}-${candidate.platformUserId}`}
          rows={candidates}
        />
      </Card>

      <Card flush title="Identities">
        <DataTable columns={columns} hideHeader label="Identities and roles" loading={state === "loading"} rowKey={(member) => member.id} rows={members} />
      </Card>

      <Card
        actions={<Status kind={bootstrap.state === "claimed" ? "ok" : "warning"} label={bootstrap.state === "claimed" ? "Complete" : "Action required"} />}
        description={bootstrap.state === "claimed" ? undefined : `Sign in with the configured Telegram account${bootstrap.telegramId ? ` (${bootstrap.telegramId})` : ""} to create the first Owner.`}
        flush
        title="Initial owner"
      >
        <Details flush items={[
          { label: "Telegram ID", value: bootstrap.telegramId ?? "Set in the deployment configuration", mono: bootstrap.telegramId !== null },
          { label: "Role", value: "Owner" },
          ...(bootstrap.state === "claimed" ? [{ label: "Claimed", value: bootstrap.claimedAt }] : []),
        ]} label="Initial owner" />
        <div className="card-actions">
          <Button aria-expanded={showBootstrap} icon={showBootstrap ? "expand_less" : "expand_more"} onClick={() => setShowBootstrap((value) => !value)} size="small" variant="text">{showBootstrap ? "Hide setup steps" : "How the first Owner is set"}</Button>
        </div>
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
        {managed && <LinkedAccounts bare member={managed} />}
      </Sheet>
    </div>
  );
}

function Roles({ roles, state, error, failure, onRetry }: { roles: Role[]; state: "loading" | "ready" | "error"; error: string; failure: ApiFailureKind; onRetry: () => void }) {
  // Permissions open beside the table rather than inside it. Expanding a row
  // pushed every row below it down, and the taller the directory the further
  // the page jumped under the pointer that opened it.
  const [reading, setReading] = useState<string | null>(null);
  const role = roles.find((item) => item.id === reading);
  const filter = useFilter(roles, (item) => [item.name, item.description]);
  const columns: Column<Role>[] = [
    { id: "role", label: "Role", width: "160px", render: (role) => <strong>{role.name}</strong> },
    { id: "description", label: "Description", width: "50%", render: (role) => role.description },
    {
      id: "permissions",
      label: "Permissions",
      render: (role) => (
        <button className="row-link" onClick={() => setReading(role.id)} type="button">
          {plural(role.permissions.length, "permission")}
          <Icon name="chevron_right" size={16} />
        </button>
      ),
    },
  ];
  return (
    <div className="page">
      {/* A directory that has no route yet is not a fault, and no retry reaches
          it. Anything else keeps the banner and the retry it always had. */}
      {state === "error" && failure === "unavailable" && <Card flush><NotConnected description="Roles and their permissions appear here once the access directory is reachable." title="The access directory is not connected yet" /></Card>}
      {state === "error" && failure !== "unavailable" && <Banner actions={failure === "forbidden" ? undefined : <Button onClick={onRetry} variant="text">Try again</Button>} description={error} title={failure === "forbidden" ? "Your role cannot read this" : "Roles could not be loaded"} tone="error" />}
      {state !== "error" && <Card flush>
        <FilterBar disabled={state !== "ready"} filter={filter} label="Search roles" noun="roles" placeholder="Search by role or description" />
        <DataTable
          columns={columns}
          empty={filter.active
            ? <NoMatches filter={filter} icon="admin_panel_settings" noun="roles" />
            : <EmptyState description="The access directory returned no roles." icon="admin_panel_settings" title="No roles" />}
          label="Roles and permissions"
          loading={state === "loading"}
          rowKey={(role) => role.id}
          rows={filter.rows}
        />
      </Card>}

      <Sheet
        description={role ? `${role.system ? "Built-in role" : "Custom role"} · ${plural(role.permissions.length, "permission")}` : undefined}
        onClose={() => setReading(null)}
        open={role !== undefined}
        title={role?.name ?? "Role"}
      >
        {role && <RolePermissions key={role.id} role={role} />}
      </Sheet>
    </div>
  );
}

// A long role is hard to read line by line, so it gets the same search the
// directory has. Three permissions are quicker to scan than to search.
const SEARCHABLE_PERMISSIONS = 3;

function RolePermissions({ role }: { role: Role }) {
  const permissions = [...role.permissions].sort((a, b) => a.localeCompare(b));
  const filter = useFilter(permissions, (permission) => [permission, describePermission(permission)]);
  return (
    <div className="page">
      <p className="secondary">{role.description}</p>
      {permissions.length > SEARCHABLE_PERMISSIONS && <FilterBar filter={filter} label="Search permissions" noun="permissions" placeholder="Search by permission or description" plain />}
      {filter.rows.length === 0
        ? <NoMatches filter={filter} icon="admin_panel_settings" noun="permissions" />
        : <dl className="details">
          {filter.rows.map((permission) => (
            <div className="details-row" key={permission}>
              <dt><code>{permission}</code></dt>
              <dd>{describePermission(permission) ?? <Ghost>No description recorded for this permission.</Ghost>}</dd>
            </div>
          ))}
        </dl>}
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
    { id: "started", label: "Session started", align: "end", width: "150px", render: (game) => <label className="switch"><input aria-label={`${game.displayName} started`} checked={Boolean(subscriptions[`${game.id}.started`])} disabled={disabled} onChange={() => void toggle(`${game.id}.started`)} type="checkbox" /><span aria-hidden="true" className="switch-track" /></label> },
    { id: "stopped", label: "Session stopped", align: "end", width: "150px", render: (game) => <label className="switch"><input aria-label={`${game.displayName} stopped`} checked={Boolean(subscriptions[`${game.id}.stopped`])} disabled={disabled} onChange={() => void toggle(`${game.id}.stopped`)} type="checkbox" /><span aria-hidden="true" className="switch-track" /></label> },
  ];

  return (
    <div className="page notification-groups">
      {state === "error" && <Banner actions={<Button onClick={() => void reload()} variant="text">Try again</Button>} description={error} title="Subscriptions are unavailable" tone="error" />}
      <Card actions={<span aria-live="polite" className="secondary" role="status">{state === "saving" ? "Saving…" : state === "ready" ? "Saved to your identity" : ""}</span>} flush title="Server events">
        <DataTable columns={columns} label="Server event subscriptions" loading={state === "loading"} rowKey={(game) => game.id} rows={games} />
      </Card>
      <Card title="Game invitations">
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
