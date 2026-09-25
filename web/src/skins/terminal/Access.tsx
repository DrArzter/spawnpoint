import { useState } from "react";

import { useFilter } from "../../components/ui/Filter";
import type { AccessModel, CandidateRow, InvitationsModel, MemberRow, NotificationsModel, RolesModel, UsersModel } from "../../core/models";
import { Icon, type IconName } from "../../icons";
import { formatDateTime, plural } from "../../lib/format";
import { describePermission } from "../../lib/permissions";
import type { Game, LinkKind, Member, Role } from "../../model";
import { Avatar, Col, Details, Drawer, Empty, Field, Ghost, Key, Notice, Page, Panel, SelectInput, State, Table, Tabs, TextInput, Toggle, Verb, Verbs, Wait } from "./ui";

export function Access({ model }: Readonly<{ model: AccessModel }>) {
  return (
    <Page>
      <h1 className="visually-hidden">Access</h1>
      <Tabs label="Access sections" onChange={model.setTab} options={[{ id: "users", label: "Users" }, { id: "roles", label: "Roles", count: model.roleCount || undefined }, { id: "notifications", label: "My notifications" }]} value={model.tab} />
      <div aria-live="polite" role="tabpanel">
        {model.tab === "users" && <Users model={model.users} />}
        {model.tab === "roles" && <Roles model={model.roles} />}
        {model.tab === "notifications" && <Notifications model={model.notifications} />}
      </div>
    </Page>
  );
}

function RoleSelect({ label, value, onChange, roles, disabled, excludeOwner = false, fallback }: Readonly<{ label: string; value: string; onChange: (roleId: string) => void; roles: readonly Role[]; disabled: boolean; excludeOwner?: boolean; fallback: string }>) {
  const options = excludeOwner ? roles.filter((role) => role.id !== "owner") : roles;
  return (
    <SelectInput aria-label={label} className="t-select-inline" disabled={disabled} onChange={(event) => onChange(event.target.value)} value={value}>
      {roles.length === 0 && <option value={value}>{fallback}</option>}
      {options.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
    </SelectInput>
  );
}

function Users({ model }: Readonly<{ model: UsersModel }>) {
  const [showBootstrap, setShowBootstrap] = useState(false);
  const rolesBlocked = model.rolesLoading || model.roles.length === 0;
  const candidateColumns: readonly Col<CandidateRow>[] = [
    {
      id: "user",
      label: "User",
      render: (row) => (
        <span className="t-person">
          <Avatar name={row.candidate.displayName} photoUrl={row.candidate.photoUrl} />
          <span className="t-stack">
            <strong>{row.candidate.displayName}</strong>
            <small>{row.account} · {row.since}</small>
          </span>
        </span>
      ),
    },
    { id: "role", label: "Role", align: "end", width: "180px", render: (row) => <RoleSelect disabled={rolesBlocked} excludeOwner fallback="Loading roles…" label={`Role for ${row.candidate.displayName}`} onChange={row.setRoleId} roles={model.roles} value={row.roleId} /> },
    { id: "verbs", label: "Actions", verbs: true, render: (row) => <Verbs><Verb action={row.dismiss} size="small" /><Verb action={row.approve} size="small" tone="primary" /></Verbs> },
  ];
  const memberColumns: readonly Col<MemberRow>[] = [
    { id: "user", label: "User", render: (row) => <span className="t-person"><Avatar name={row.member.name} /><strong>{row.member.name}</strong></span> },
    { id: "role", label: "Role", align: "end", width: "180px", render: (row) => <RoleSelect disabled={rolesBlocked || row.changing} fallback={row.roleId} label={`Role for ${row.member.name}`} onChange={row.setRoleId} roles={model.roles} value={row.roleId} /> },
    { id: "verbs", label: "Actions", verbs: true, render: (row) => <Verb action={row.linkedAccounts} aria-expanded={row.member.id === model.managed?.id} size="small" /> },
  ];
  const candidates = model.candidates;
  const managedRole = model.managed ? model.roles.find((role) => role.id === model.managed?.roleId)?.name ?? model.managed.roleId : "";

  return (
    <Page>
      {candidates.status === "error" && <Notice description={candidates.error} title="Access requests could not be loaded" tone="error" verbs={<Verb action={candidates.retry} size="small" />} />}

      {model.invitations && <Invitations model={model.invitations} />}

      <Panel flush name="Access requests">
        <Table
          columns={candidateColumns}
          empty={<Empty description="Somebody appears here after signing in, or creating an account, and asking for access." title="Nobody is waiting for review" />}
          headless
          label="Access requests"
          loading={candidates.status === "loading"}
          rowKey={(row) => `${row.candidate.platform}-${row.candidate.platformUserId}`}
          rows={candidates.status === "ready" ? candidates.value : []}
        />
      </Panel>

      <Panel flush name="Identities">
        <Table columns={memberColumns} empty={<Empty title="No identities" />} headless label="Identities and roles" loading={candidates.status === "loading"} rowKey={(row) => row.member.id} rows={model.members} />
      </Panel>

      <Panel
        description={model.bootstrapDescription}
        flush
        name="Initial owner"
        verbs={<State kind={model.bootstrap.state === "claimed" ? "ok" : "warning"} label={model.bootstrap.state === "claimed" ? "Complete" : "Action required"} />}
      >
        <Details className="t-details-flush" items={[
          { label: "Telegram ID", value: model.bootstrap.telegramId ? <code>{model.bootstrap.telegramId}</code> : "Set in the deployment configuration" },
          { label: "Role", value: "Owner" },
          ...(model.bootstrap.state === "claimed" ? [{ label: "Claimed", value: formatDateTime(model.bootstrap.claimedAt) }] : []),
        ]} label="Initial owner" />
        <div className="t-panel-foot">
          <Key aria-expanded={showBootstrap} icon={showBootstrap ? "expand_less" : "expand_more"} label={showBootstrap ? "Hide setup steps" : "How the first Owner is set"} onClick={() => setShowBootstrap((value) => !value)} size="small" />
        </div>
        {showBootstrap && (
          <ol className="t-steps">
            <li>Set the initial Owner Telegram ID in the deployment configuration.</li>
            <li>Sign in through Telegram with that exact account.</li>
            <li>Spawnpoint creates the Owner and closes the one-time setup for good.</li>
            <li>Add game and network accounts from the Owner profile once linking exists.</li>
          </ol>
        )}
      </Panel>

      <Drawer closeActionId={model.closeManaged.id} description={model.managed ? `${model.managed.name} · ${managedRole}` : undefined} onClose={model.closeManaged.run} open={model.managed !== null} title="Linked accounts">
        {model.managed && <LinkedAccounts member={model.managed} />}
      </Drawer>
    </Page>
  );
}

// A link either proves who you are, names you inside a game, or admits a
// device to the network; the grouping says which.
const linkProviders: Readonly<Record<LinkKind, { label: string; icon: IconName; purpose: string }>> = {
  telegram: { label: "Telegram", icon: "send", purpose: "Sign-in" },
  email: { label: "Email", icon: "mail", purpose: "Sign-in" },
  discord: { label: "Discord", icon: "group", purpose: "Sign-in" },
  minecraft: { label: "Minecraft", icon: "public", purpose: "Game identity" },
  factorio: { label: "Factorio", icon: "public", purpose: "Game identity" },
  steam: { label: "Steam", icon: "sports_esports", purpose: "Game identity" },
  zerotier: { label: "ZeroTier client", icon: "dns", purpose: "Network" },
};

function LinkedAccounts({ member }: Readonly<{ member: Member }>) {
  const purposes = ["Sign-in", "Game identity", "Network"];
  return (
    <div className="t-page">
      <p className="t-note"><span aria-hidden="true" className="t-mark t-mark-off">[-]</span><strong>Adding and removing accounts is not connected yet.</strong> Existing links come from Spawnpoint.</p>
      {member.links.length === 0 && <Empty description="Links appear once their verification flow exists." title="No linked accounts" />}
      {purposes.map((purpose) => {
        const links = member.links.filter((link) => linkProviders[link.kind].purpose === purpose);
        if (links.length === 0) return null;
        return (
          <section className="t-details-group" key={purpose}>
            <h3 className="t-group-name">{purpose}</h3>
            <ul className="t-list">
              {links.map((link) => (
                <li className="t-list-row" key={link.id}>
                  <span aria-hidden="true" className="t-list-icon"><Icon name={linkProviders[link.kind].icon} size={18} /></span>
                  <span className="t-stack">
                    <strong>{linkProviders[link.kind].label}</strong>
                    <code>{link.value}</code>
                  </span>
                  {link.verified ? <State kind="ok" label="Verified" /> : <State kind="pending" label="Pending verification" />}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function Invitations({ model }: Readonly<{ model: InvitationsModel }>) {
  const list = model.list;
  return (
    <Panel description="Invite someone to the project, not to a particular world. They choose how to sign in and join as a Viewer." name="Invite to Spawnpoint">
      <form className="t-invite-form" onSubmit={(event) => { event.preventDefault(); model.create.run(); }}>
        {model.emailMode && (
          <Field hint="The invitation is valid only after this address is verified." label="Invite email">
            <TextInput autoComplete="email" onChange={(event) => model.setEmail(event.target.value)} placeholder="person@example.com" required type="email" value={model.email} />
          </Field>
        )}
        {model.emailMode === false && <p className="t-copy-line">This deployment has no email delivery. Share the one-time link yourself; the recipient signs in with an enabled provider.</p>}
        <Verb action={model.create} className="t-invite-verb" tone="primary" type="submit" />
      </form>
      {model.issued && <div className="t-invite-link">
        <p>{model.issued.email ? `This one-time link is for ${model.issued.email}. The recipient must verify that address.` : "This one-time link is not email-bound."} Copy it now; it will not be shown again.</p>
        <div className="t-invite-link-row">
          <Field label="Invitation link"><TextInput mono onFocus={(event) => event.currentTarget.select()} readOnly value={model.issued.url} /></Field>
          <Verb action={model.issued.copy} />
        </div>
      </div>}
      {list.status === "error" && <Notice description={list.error} title="Invitations could not be loaded" tone="error" verbs={<Verb action={list.retry} size="small" />} />}
      {list.status === "loading" && <Wait label="Loading invitations" />}
      {list.status === "ready" && list.value.length === 0 && <Empty description="Create a link to let someone join with their preferred sign-in method." title="No invitations yet" />}
      {list.status === "ready" && list.value.length > 0 && <section className="t-details-group">
        <h3 className="t-group-name">Recent invitations</h3>
        <ul className="t-list">
          {list.value.map(({ invitation, revoke }) => <li className="t-list-row" key={invitation.id}>
            <span className="t-stack">
              <strong>{invitation.deliveryEmail ?? "Shareable link"}</strong>
              <small>{invitation.status.toLowerCase()} · Created {formatDateTime(invitation.createdAt)} · Expires {formatDateTime(invitation.expiresAt)}{invitation.delivery === "failed" ? " · Email failed" : ""}</small>
            </span>
            {revoke && <Verb action={revoke} size="small" />}
          </li>)}
        </ul>
      </section>}
    </Panel>
  );
}

function Roles({ model }: Readonly<{ model: RolesModel }>) {
  const roles = model.roles.status === "ready" ? model.roles.value : [];
  const filter = useFilter(roles, (item) => [item.name, item.description]);
  const columns: readonly Col<Role>[] = [
    { id: "role", label: "Role", width: "160px", render: (role) => <strong>{role.name}</strong> },
    { id: "description", label: "Description", width: "50%", render: (role) => role.description },
    { id: "permissions", label: "Permissions", render: (role) => { const read = model.read(role); return <Key bare data-action={read.id} icon="chevron_right" label={read.label} onClick={read.run} size="small" tone="primary" />; } },
  ];
  const state = model.roles;
  return (
    <Page>
      {state.status === "error" && state.kind === "unavailable" && <Panel><Empty description="Roles and their permissions appear here once the access directory is reachable." title="The access directory is not connected yet" /></Panel>}
      {state.status === "error" && state.kind !== "unavailable" && <Notice description={state.error} title={state.kind === "forbidden" ? "Your role cannot read this" : "Roles could not be loaded"} tone="error" verbs={state.kind === "forbidden" ? undefined : <Verb action={state.retry} size="small" />} />}
      {state.status !== "error" && <Panel flush>
        <div className="t-filter-row">
          <Field hideLabel label="Search roles">
            <TextInput disabled={state.status !== "ready"} onChange={(event) => filter.setQuery(event.target.value)} placeholder="Search by role or description" ref={filter.field} type="search" value={filter.query} />
          </Field>
          {filter.active && <span className="t-filter-count">{filter.rows.length} of {filter.total}</span>}
        </div>
        <Table
          columns={columns}
          empty={filter.active ? <Empty description={`Nothing matches "${filter.query}".`} title="No matching roles" verbs={<Key label="Clear search" onClick={filter.clear} size="small" />} /> : <Empty description="The access directory returned no roles." title="No roles" />}
          label="Roles and permissions"
          loading={state.status === "loading"}
          rowKey={(role) => role.id}
          rows={filter.rows}
        />
      </Panel>}

      <Drawer
        closeActionId={model.closeReading.id}
        description={model.reading ? roleDescription(model.reading) : undefined}
        onClose={model.closeReading.run}
        open={model.reading !== null}
        title={model.reading?.name ?? "Role"}
      >
        {model.reading && <RolePermissions key={model.reading.id} role={model.reading} />}
      </Drawer>
    </Page>
  );
}

function roleDescription(role: Role): string {
  const kind = role.system ? "Built-in role" : "Custom role";
  return `${kind} · ${plural(role.permissions.length, "permission")}`;
}

const SEARCHABLE_PERMISSIONS = 3;

function RolePermissions({ role }: Readonly<{ role: Role }>) {
  const permissions = [...role.permissions].sort((a, b) => a.localeCompare(b));
  const filter = useFilter(permissions, (permission) => [permission, describePermission(permission)]);
  return (
    <div className="t-page">
      <p className="t-copy-line">{role.description}</p>
      {permissions.length > SEARCHABLE_PERMISSIONS && (
        <Field hideLabel label="Search permissions">
          <TextInput onChange={(event) => filter.setQuery(event.target.value)} placeholder="Search by permission or description" ref={filter.field} type="search" value={filter.query} />
        </Field>
      )}
      {filter.rows.length === 0
        ? <Empty description={`Nothing matches "${filter.query}".`} title="No matching permissions" verbs={<Key label="Clear search" onClick={filter.clear} size="small" />} />
        : <Details items={filter.rows.map((permission) => ({ label: permission, value: describePermission(permission) ?? <Ghost>No description recorded for this permission.</Ghost> }))} label="Permissions" />}
    </div>
  );
}

function Notifications({ model }: Readonly<{ model: NotificationsModel }>) {
  const columns: readonly Col<Game>[] = [
    { id: "game", label: "Game", render: (game) => <strong>{game.displayName}</strong> },
    { id: "started", label: "Session started", align: "end", width: "170px", render: (game) => <Toggle action={model.toggle(`${game.id}.started`, `${game.displayName} started`)} checked={Boolean(model.subscriptions[`${game.id}.started`])} labelHidden /> },
    { id: "stopped", label: "Session stopped", align: "end", width: "170px", render: (game) => <Toggle action={model.toggle(`${game.id}.stopped`, `${game.displayName} stopped`)} checked={Boolean(model.subscriptions[`${game.id}.stopped`])} labelHidden /> },
  ];
  return (
    <Page>
      {model.state === "error" && <Notice description={model.error} title="Subscriptions are unavailable" tone="error" verbs={model.retry ? <Verb action={model.retry} size="small" /> : undefined} />}
      <Panel flush name="Session events" verbs={<span aria-live="polite" className="t-panel-note" role="status">{model.saveStatus}</span>}>
        <Table columns={columns} empty={<Empty title="No games" />} label="Session event subscriptions" loading={model.state === "loading"} rowKey={(game) => game.id} rows={model.games} />
      </Panel>
      <Panel name="Game invitations">
        {model.state === "loading" ? <Wait label="Loading invitation preferences" /> : <div className="t-toggle-list">
          <Toggle action={model.toggle("invitation.broadcast", "Invitations sent to everyone")} checked={Boolean(model.subscriptions["invitation.broadcast"])} note="A player invited everyone to join a game" />
          <Toggle action={model.toggle("invitation.direct", "Invitations sent directly to me")} checked={Boolean(model.subscriptions["invitation.direct"])} note="A player invited only selected people" />
        </div>}
      </Panel>
      <Panel>
        <div className="t-delivery">
          <span className="t-stack"><strong>Delivery channel</strong><small>Telegram receives every category enabled above.</small></span>
          <State kind="ok" label="Telegram linked" />
        </div>
      </Panel>
    </Page>
  );
}
