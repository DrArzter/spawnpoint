import { useState } from "react";

import { Avatar } from "../../components/Avatar";
import { LinkedAccounts } from "../../components/LinkedAccounts";
import { ActionRow } from "../../components/ui/Button";
import { Column, DataTable } from "../../components/ui/DataTable";
import { Sheet } from "../../components/ui/Dialog";
import { InlineSelect, Switch, TextField } from "../../components/ui/Fields";
import { FilterBar, NoMatches, useFilter } from "../../components/ui/Filter";
import { SkeletonRows } from "../../components/ui/Skeleton";
import { Status } from "../../components/ui/Status";
import { Banner, Card, Details, EmptyState, Ghost, NotConnected } from "../../components/ui/Surfaces";
import { Tabs } from "../../components/ui/Tabs";
import type { AccessModel, CandidateRow, InvitationsModel, MemberRow, NotificationsModel, RolesModel, UsersModel } from "../../core/models";
import { Icon } from "../../icons";
import { formatDateTime, plural } from "../../lib/format";
import { describePermission } from "../../lib/permissions";
import type { Game, Role } from "../../model";
import { ActionButton } from "./actions";

export function Access({ model }: Readonly<{ model: AccessModel }>) {
  return (
    <div className="page">
      <h1 className="visually-hidden">Access</h1>
      <Tabs label="Access sections" onChange={model.setTab} options={[{ id: "users", label: "Users", icon: "group" }, { id: "roles", label: "Roles", icon: "admin_panel_settings", count: model.roleCount || undefined }, { id: "notifications", label: "My notifications", icon: "notifications" }]} value={model.tab} />
      <div aria-live="polite" role="tabpanel">
        {model.tab === "users" && <Users model={model.users} />}
        {model.tab === "roles" && <Roles model={model.roles} />}
        {model.tab === "notifications" && <Notifications model={model.notifications} />}
      </div>
    </div>
  );
}

function RoleSelect({ label, value, onChange, roles, disabled, excludeOwner = false, fallback }: Readonly<{ label: string; value: string; onChange: (roleId: string) => void; roles: readonly Role[]; disabled: boolean; excludeOwner?: boolean; fallback: string }>) {
  const options = excludeOwner ? roles.filter((role) => role.id !== "owner") : roles;
  return (
    <InlineSelect aria-label={label} disabled={disabled} onChange={(event) => onChange(event.target.value)} value={value}>
      {roles.length === 0 && <option value={value}>{fallback}</option>}
      {options.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
    </InlineSelect>
  );
}

function Users({ model }: Readonly<{ model: UsersModel }>) {
  const [showBootstrap, setShowBootstrap] = useState(false);
  const rolesBlocked = model.rolesLoading || model.roles.length === 0;
  const candidateColumns: Column<CandidateRow>[] = [
    {
      id: "user",
      label: "User",
      render: (row) => (
        <span className="user-cell">
          <Avatar name={row.candidate.displayName} photoUrl={row.candidate.photoUrl} />
          <span>
            <strong>{row.candidate.displayName}</strong>
            <small>{row.account} · {row.since}</small>
          </span>
        </span>
      ),
    },
    { id: "role", label: "Role", align: "end", width: "180px", render: (row) => <RoleSelect disabled={rolesBlocked} excludeOwner fallback="Loading roles…" label={`Role for ${row.candidate.displayName}`} onChange={row.setRoleId} roles={model.roles} value={row.roleId} /> },
    {
      id: "actions",
      label: "Actions",
      actions: true,
      render: (row) => (
        <ActionRow>
          <ActionButton action={row.dismiss} size="small" variant="outlined" />
          <ActionButton action={row.approve} size="small" variant="filled" />
        </ActionRow>
      ),
    },
  ];
  const columns: Column<MemberRow>[] = [
    // The identity id is not shown. It is an internal handle, and a table is
    // read to tell one person from another, which their name already does.
    { id: "user", label: "User", render: (row) => <span className="user-cell"><Avatar name={row.member.name} /><strong>{row.member.name}</strong></span> },
    // Right-aligned against the actions beside it, so the control that changes
    // a role sits next to the one that opens their accounts rather than
    // stranded in the middle of the row.
    { id: "role", label: "Role", align: "end", width: "180px", render: (row) => <RoleSelect disabled={rolesBlocked || row.changing} fallback={row.roleId} label={`Role for ${row.member.name}`} onChange={row.setRoleId} roles={model.roles} value={row.roleId} /> },
    { id: "actions", label: "Actions", actions: true, render: (row) => <ActionButton action={row.linkedAccounts} aria-expanded={row.member.id === model.managed?.id} size="small" variant="text" /> },
  ];
  const candidates = model.candidates;
  const managedRole = model.managed ? model.roles.find((role) => role.id === model.managed?.roleId)?.name ?? model.managed.roleId : "";

  return (
    <div className="page">
      {candidates.status === "error" && <Banner actions={<ActionButton action={candidates.retry} variant="text" />} description={candidates.error} title="Access requests could not be loaded" tone="error" />}

      {model.invitations && <Invitations model={model.invitations} />}

      {/* The same shape as Identities, because it is the same thing: people and
          what may be done about them. */}
      <Card flush title="Access requests">
        <DataTable
          columns={candidateColumns}
          decision
          hideHeader
          empty={<EmptyState description="Somebody appears here after signing in, or creating an account, and asking for access." icon="person_add" title="Nobody is waiting for review" />}
          label="Access requests"
          loading={candidates.status === "loading"}
          loadingRows={2}
          rowKey={(row) => `${row.candidate.platform}-${row.candidate.platformUserId}`}
          rows={candidates.status === "ready" ? candidates.value : []}
        />
      </Card>

      <Card flush title="Identities">
        <DataTable columns={columns} decision hideHeader label="Identities and roles" loading={candidates.status === "loading"} rowKey={(row) => row.member.id} rows={model.members} />
      </Card>

      <Card
        actions={<Status kind={model.bootstrap.state === "claimed" ? "ok" : "warning"} label={model.bootstrap.state === "claimed" ? "Complete" : "Action required"} />}
        description={model.bootstrapDescription}
        flush
        title="Initial owner"
      >
        <Details flush items={[
          { label: "Telegram ID", value: model.bootstrap.telegramId ?? "Set in the deployment configuration", mono: model.bootstrap.telegramId !== null },
          { label: "Role", value: "Owner" },
          ...(model.bootstrap.state === "claimed" ? [{ label: "Claimed", value: model.bootstrap.claimedAt }] : []),
        ]} label="Initial owner" />
        <div className="card-actions">
          <button aria-expanded={showBootstrap} className="btn btn-text btn-small" onClick={() => setShowBootstrap((value) => !value)} type="button">
            <Icon name={showBootstrap ? "expand_less" : "expand_more"} size={18} />{showBootstrap ? "Hide setup steps" : "How the first Owner is set"}
          </button>
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

      <Sheet closeActionId={model.closeManaged.id} description={model.managed ? `${model.managed.name} · ${managedRole}` : undefined} onClose={model.closeManaged.run} open={model.managed !== null} title="Linked accounts">
        {model.managed && <LinkedAccounts bare member={model.managed} />}
      </Sheet>
    </div>
  );
}

function Invitations({ model }: Readonly<{ model: InvitationsModel }>) {
  const list = model.list;
  return (
    <Card title="Invite to Spawnpoint">
      <form className="access-invite-form" onSubmit={(event) => { event.preventDefault(); model.create.run(); }}>
        {model.emailMode && <TextField autoComplete="email" label="Invite email" onChange={(event) => model.setEmail(event.target.value)} placeholder="person@example.com" required type="email" value={model.email} />}
        {model.emailMode === false && <p>This deployment has no email delivery. Share the one-time link yourself; the recipient signs in with an enabled provider.</p>}
        <ActionButton action={model.create} type="submit" variant="filled" />
      </form>
      {model.issued && <div className="access-invite-link">
        <p>{model.issued.email ? `This one-time link is for ${model.issued.email}. The recipient must verify that address.` : "This one-time link is not email-bound."} Copy it now; it will not be shown again.</p>
        <TextField label="Invitation link" onFocus={(event) => event.currentTarget.select()} readOnly value={model.issued.url} />
        <ActionButton action={model.issued.copy} variant="outlined" />
      </div>}
      {list.status === "error" && <Banner actions={<ActionButton action={list.retry} variant="text" />} description={list.error} title="Invitations could not be loaded" tone="error" />}
      {list.status === "loading" && <p>Loading invitations…</p>}
      {list.status === "ready" && list.value.length === 0 && <EmptyState description="Create a link to let someone join with their preferred sign-in method." icon="person_add" title="No invitations yet" />}
      {list.status === "ready" && list.value.length > 0 && <div className="access-invite-list">
        <h3>Recent invitations</h3>
        <ul>
          {list.value.map(({ invitation, revoke }) => <li key={invitation.id}>
            <span><strong>{invitation.deliveryEmail ?? "Shareable link"}</strong><small>{invitation.status.toLowerCase()} · Created {formatDateTime(invitation.createdAt)} · Expires {formatDateTime(invitation.expiresAt)}{invitation.delivery === "failed" ? " · Email failed" : ""}</small></span>
            {revoke && <ActionButton action={revoke} size="small" variant="text" />}
          </li>)}
        </ul>
      </div>}
    </Card>
  );
}

function Roles({ model }: Readonly<{ model: RolesModel }>) {
  const roles = model.roles.status === "ready" ? model.roles.value : [];
  const filter = useFilter(roles, (item) => [item.name, item.description]);
  const columns: Column<Role>[] = [
    { id: "role", label: "Role", width: "160px", render: (role) => <strong>{role.name}</strong> },
    { id: "description", label: "Description", width: "50%", render: (role) => role.description },
    { id: "permissions", label: "Permissions", render: (role) => { const read = model.read(role); return <button className="row-link" data-action={read.id} onClick={read.run} type="button">{read.label}<Icon name="chevron_right" size={16} /></button>; } },
  ];
  const state = model.roles;
  return (
    <div className="page">
      {/* A directory that has no route yet is not a fault, and no retry reaches
          it. Anything else keeps the banner and the retry it always had. */}
      {state.status === "error" && state.kind === "unavailable" && <Card flush><NotConnected description="Roles and their permissions appear here once the access directory is reachable." title="The access directory is not connected yet" /></Card>}
      {state.status === "error" && state.kind !== "unavailable" && <Banner actions={state.kind === "forbidden" ? undefined : <ActionButton action={state.retry} variant="text" />} description={state.error} title={state.kind === "forbidden" ? "Your role cannot read this" : "Roles could not be loaded"} tone="error" />}
      {state.status !== "error" && <Card flush>
        <FilterBar disabled={state.status !== "ready"} filter={filter} label="Search roles" noun="roles" placeholder="Search by role or description" />
        <DataTable
          columns={columns}
          empty={filter.active ? <NoMatches filter={filter} icon="admin_panel_settings" noun="roles" /> : <EmptyState description="The access directory returned no roles." icon="admin_panel_settings" title="No roles" />}
          label="Roles and permissions"
          loading={state.status === "loading"}
          rowKey={(role) => role.id}
          rows={filter.rows}
        />
      </Card>}

      <Sheet
        description={model.reading ? roleDescription(model.reading) : undefined}
        closeActionId={model.closeReading.id}
        onClose={model.closeReading.run}
        open={model.reading !== null}
        title={model.reading?.name ?? "Role"}
      >
        {model.reading && <RolePermissions key={model.reading.id} role={model.reading} />}
      </Sheet>
    </div>
  );
}

function roleDescription(role: Role): string {
  const kind = role.system ? "Built-in role" : "Custom role";
  return `${kind} · ${plural(role.permissions.length, "permission")}`;
}

// A long role is hard to read line by line, so it gets the same search the
// directory has. Three permissions are quicker to scan than to search.
const SEARCHABLE_PERMISSIONS = 3;

function RolePermissions({ role }: Readonly<{ role: Role }>) {
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

function Notifications({ model }: Readonly<{ model: NotificationsModel }>) {
  const columns: Column<Game>[] = [
    { id: "game", label: "Game", render: (game) => <strong>{game.displayName}</strong> },
    { id: "started", label: "Session started", align: "end", width: "150px", render: (game) => <SubscriptionSwitch action={model.toggle(`${game.id}.started`, `${game.displayName} started`)} checked={Boolean(model.subscriptions[`${game.id}.started`])} /> },
    { id: "stopped", label: "Session stopped", align: "end", width: "150px", render: (game) => <SubscriptionSwitch action={model.toggle(`${game.id}.stopped`, `${game.displayName} stopped`)} checked={Boolean(model.subscriptions[`${game.id}.stopped`])} /> },
  ];
  return (
    <div className="page notification-groups">
      {model.state === "error" && <Banner actions={model.retry ? <ActionButton action={model.retry} variant="text" /> : undefined} description={model.error} title="Subscriptions are unavailable" tone="error" />}
      <Card actions={<span aria-live="polite" className="secondary" role="status">{model.saveStatus}</span>} flush title="Session events">
        <DataTable columns={columns} label="Session event subscriptions" loading={model.state === "loading"} rowKey={(game) => game.id} rows={model.games} />
      </Card>
      <Card title="Game invitations">
        {model.state === "loading" ? <SkeletonRows label="Loading invitation preferences" rows={2} /> : <>
          <SubscriptionSwitch action={model.toggle("invitation.broadcast", "Invitations sent to everyone")} checked={Boolean(model.subscriptions["invitation.broadcast"])} note="A player invited everyone to join a game" />
          <SubscriptionSwitch action={model.toggle("invitation.direct", "Invitations sent directly to me")} checked={Boolean(model.subscriptions["invitation.direct"])} note="A player invited only selected people" />
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

function SubscriptionSwitch({ action, checked, note }: Readonly<{ action: { id: string; label: string; run: () => void; disabled?: boolean }; checked: boolean; note?: string }>) {
  return <Switch actionId={action.id} checked={checked} disabled={action.disabled} label={action.label} labelHidden={note === undefined} note={note} onChange={action.run} />;
}
