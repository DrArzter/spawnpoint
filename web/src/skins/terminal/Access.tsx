import { useState } from "react";

import { useFilter } from "../../components/ui/Filter";
import type { AccessModel, CandidateRow, InvitationsModel, MemberRow, NotificationsModel, RoleEditorModel, RolesModel, UsersModel } from "../../core/models";
import { Icon, type IconName } from "../../icons";
import { formatDateTime, plural } from "../../lib/format";
import { permissionGroups, ROLE_ID_HINT, roleFormFields, protectedRoleName, rolePermissions, type RoleChoice } from "../../core/roles";
import type { Game, LinkKind, Member, PermissionInfo, Role } from "../../model";
import { ConfirmationDialog } from "./Dialogs";
import { Col, Details, Drawer, Empty, Field, FilterRow, Ghost, Indicator, Key, LoadError, NoMatches, Notice, Overflow, Page, Panel, Person, SelectInput, SkeletonRows, State, Table, Tabs, TextInput, Toggle, Verb } from "./ui";

export function Access({ model }: Readonly<{ model: AccessModel }>) {
  return (
    <Page>
      <h1 className="visually-hidden">Access</h1>
      <Tabs label="Access sections" onChange={model.setTab} options={[{ id: "users", label: "Users" }, { id: "roles", label: "Roles", count: model.roleCount || undefined }, { id: "notifications", label: "Notifications" }]} value={model.tab} />
      <div aria-live="polite" role="tabpanel">
        {model.tab === "users" && <Users model={model.users} />}
        {model.tab === "roles" && <Roles catalogue={model.catalogue} model={model.roles} />}
        {model.tab === "notifications" && <Notifications model={model.notifications} />}
      </div>
    </Page>
  );
}

function RoleSelect({ label, choice, onChange }: Readonly<{ label: string; choice: RoleChoice; onChange: (roleId: string) => void }>) {
  return (
    <SelectInput aria-label={label} className="t-select-inline" disabled={choice.disabled} onChange={(event) => onChange(event.target.value)} value={choice.value}>
      {choice.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </SelectInput>
  );
}

function Users({ model }: Readonly<{ model: UsersModel }>) {
  const [showBootstrap, setShowBootstrap] = useState(false);
  const candidateColumns: readonly Col<CandidateRow>[] = [
    {
      id: "user",
      label: "User",
      render: (row) => <Person detail={<>{row.account} · {row.since}</>} name={row.candidate.displayName} photoUrl={row.candidate.photoUrl} />,
    },
    { id: "role", label: "Role", align: "end", width: "180px", render: (row) => <RoleSelect choice={row.role} label={`Role for ${row.candidate.displayName}`} onChange={row.setRoleId} /> },
    { id: "verbs", label: "Actions", verbs: true, width: "80px", render: (row) => <Overflow groups={[[row.approve, row.dismiss]]} label={`Actions for ${row.candidate.displayName}`} size="small" /> },
  ];
  const memberColumns: readonly Col<MemberRow>[] = [
    { id: "user", label: "User", render: (row) => <Person name={row.member.name} /> },
    { id: "role", label: "Role", align: "end", width: "180px", render: (row) => <RoleSelect choice={row.role} label={`Role for ${row.member.name}`} onChange={row.setRoleId} /> },
    { id: "verbs", label: "Actions", verbs: true, width: "80px", render: (row) => <Overflow groups={[[row.linkedAccounts], row.remove ? [row.remove] : []]} label={`Actions for ${row.member.name}`} menu size="small" /> },
  ];
  const candidates = model.candidates;
  const managedRole = model.managed ? model.roles.find((role) => role.id === model.managed?.roleId)?.name ?? model.managed.roleId : "";

  return (
    <Page>
      {candidates.status === "error" && <LoadError state={candidates} title="Access requests could not be loaded" verb="read requests" />}

      {model.invitations && <Invitations model={model.invitations} />}

      <Panel flush name="Access requests">
        <Table
          columns={candidateColumns}
          decision
          empty={<Empty title="No access requests" />}
          headless
          label="Access requests"
          loading={candidates.status === "loading"}
          rowKey={(row) => row.id}
          rows={candidates.status === "ready" ? candidates.value : []}
        />
      </Panel>

      <Panel flush name="Identities">
        <Table columns={memberColumns} decision empty={<Empty title="No identities" />} headless label="Identities and roles" loading={candidates.status === "loading"} rowKey={(row) => row.member.id} rows={model.members} />
      </Panel>

      <Panel
        flush
        head={<State kind={model.bootstrap.state === "claimed" ? "ok" : "warning"} label={model.bootstrap.state === "claimed" ? "Complete" : "Action required"} />}
        name="Initial owner"
      >
        <Details className="t-details-flush" items={[
          { label: "Telegram ID", value: model.bootstrap.telegramId ? <code>{model.bootstrap.telegramId}</code> : "Set in the deployment configuration" },
          { label: "Role", value: protectedRoleName(model.roles) ?? "—" },
          ...(model.bootstrap.state === "claimed" ? [{ label: "Claimed", value: formatDateTime(model.bootstrap.claimedAt) }] : []),
        ]} label="Initial owner" />
        <div className="t-panel-foot">
          <Key aria-expanded={showBootstrap} label={showBootstrap ? "Hide setup steps" : "How the first Owner is set"} onClick={() => setShowBootstrap((value) => !value)} size="small" />
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

      <Drawer cancel={model.closeManaged} cancelLabel="Close" closeActionId={model.closeManaged.id} description={model.managed ? `${model.managed.name} · ${managedRole}` : undefined} onClose={model.closeManaged.run} open={model.managed !== null} title="Linked accounts">
        {model.managed && <LinkedAccounts member={model.managed} />}
      </Drawer>

      <ConfirmationDialog model={model.deletion} />
    </Page>
  );
}

// A link either proves who you are, names you inside a game, or admits a
// device to the network; the grouping says which.
const linkProviders: Readonly<Record<LinkKind, { label: string; icon: IconName; purpose: string }>> = {
  telegram: { label: "Telegram", icon: "send", purpose: "Sign-in" },
  email: { label: "Email", icon: "mail", purpose: "Sign-in" },
  google: { label: "Google", icon: "account_circle", purpose: "Sign-in" },
  discord: { label: "Discord", icon: "group", purpose: "Sign-in" },
  minecraft: { label: "Minecraft", icon: "sports_esports", purpose: "Game identity" },
  factorio: { label: "Factorio", icon: "sports_esports", purpose: "Game identity" },
  steam: { label: "Steam", icon: "sports_esports", purpose: "Game identity" },
  zerotier: { label: "ZeroTier", icon: "hub", purpose: "Network" },
};

function LinkedAccounts({ member }: Readonly<{ member: Member }>) {
  const purposes = ["Sign-in", "Game identity", "Network"];
  return (
    <div className="t-page">
      {member.links.length === 0 && <Empty title="No linked accounts" />}
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
                  <Indicator kind={link.verified ? "ok" : "pending"} label={link.verified ? "Verified" : "Pending verification"} />
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
    <Panel name="Invite to Spawnpoint">
      <form className="t-entry-form" onSubmit={(event) => { event.preventDefault(); model.create.run(); }}>
        {model.emailMode && (
          <Field label="Invite email">
            <TextInput autoComplete="email" onChange={(event) => model.setEmail(event.target.value)} placeholder="person@example.com" required type="email" value={model.email} />
          </Field>
        )}
        {model.emailMode === false && <p className="t-copy-line">This deployment has no email delivery. Share the one-time link yourself; the recipient signs in with an enabled provider.</p>}
        <Verb action={model.create} className="t-entry-verb" tone="primary" type="submit" />
      </form>
      {model.issued && <div className="t-invite-link">
        <p>{model.issued.email ? `This one-time link is for ${model.issued.email}. The recipient must verify that address.` : "This one-time link is not email-bound."} Copy it now; it will not be shown again.</p>
        <div className="t-invite-link-row">
          <Field label="Invitation link"><TextInput mono onFocus={(event) => event.currentTarget.select()} readOnly value={model.issued.url} /></Field>
          <Verb action={model.issued.copy} />
        </div>
      </div>}
      {list.status === "error" && <LoadError state={list} title="Invitations could not be loaded" verb="read invitations" />}
      {list.status === "loading" && <SkeletonRows label="Loading invitations" rows={3} />}
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

function Roles({ model, catalogue }: Readonly<{ model: RolesModel; catalogue: readonly PermissionInfo[] }>) {
  const roles = model.roles.status === "ready" ? model.roles.value : [];
  const filter = useFilter(roles, (item) => [item.name, item.description]);
  const columns: readonly Col<Role>[] = [
    { id: "role", label: "Role", width: "160px", render: (role) => <strong>{role.name}</strong> },
    { id: "description", label: "Description", width: "50%", render: (role) => role.description },
    { id: "permissions", label: "Permissions", render: (role) => <Verb action={model.read(role)} size="small" tone="primary" /> },
    { id: "verbs", label: "Actions", verbs: true, width: "80px", render: (role) => <Overflow groups={[[model.edit(role)], [model.remove(role)]]} label={`Actions for ${role.name}`} menu size="small" /> },
  ];
  const state = model.roles;
  return (
    <Page>
      {state.status === "error" && <LoadError state={state} title="Roles could not be loaded" verb="read roles" />}
      {state.status !== "error" && <Panel flush>
        <FilterRow disabled={state.status !== "ready"} filter={filter} label="Search roles" placeholder="Search by role or description">
          <Verb action={model.create} tone="primary" />
        </FilterRow>
        <Table
          columns={columns}
          empty={filter.active ? <NoMatches filter={filter} noun="roles" /> : <Empty title="No roles" />}
          label="Roles and permissions"
          loading={state.status === "loading"}
          rowKey={(role) => role.id}
          rows={filter.rows}
        />
      </Panel>}

      <Panel name="Default role">
        <Field label="Given on approval">
          <RoleSelect choice={model.defaultRole.choice} label="Default role" onChange={model.defaultRole.set} />
        </Field>
      </Panel>

      <ConfirmationDialog model={model.deletion} />
      <RoleEditor model={model.editor} />

      <Drawer
        cancel={model.closeReading}
        cancelLabel="Close"
        closeActionId={model.closeReading.id}
        description={model.reading ? roleDescription(model.reading) : undefined}
        footer={model.reading && <><Verb action={model.edit(model.reading)} /><Verb action={model.remove(model.reading)} tone="danger" /></>}
        onClose={model.closeReading.run}
        open={model.reading !== null}
        title={model.reading?.name ?? "Role"}
      >
        {model.reading && <RolePermissions catalogue={catalogue} key={model.reading.id} role={model.reading} />}
      </Drawer>
    </Page>
  );
}

function roleDescription(role: Role): string {
  const kind = role.builtIn ? "Built-in role" : "Custom role";
  return `${kind} · ${plural(role.permissions.length, "permission")} · ${plural(role.holders, "person", "people")}`;
}

function RoleEditor({ model }: Readonly<{ model: RoleEditorModel | null }>) {
  const fields = model && roleFormFields(model);
  return (
    <Drawer
      cancel={model?.cancel}
      closeActionId={model?.cancel.id}
      footer={model && <Verb action={model.submit} tone="primary" />}
      onClose={model?.cancel.run ?? (() => undefined)}
      open={model !== null}
      title={model?.title ?? "Role"}
    >
      {model && (
        <div className="t-form">
          <Field label="Name">
            <TextInput data-autofocus {...fields!.name} />
          </Field>
          {model.mode === "create" && (
            <Field error={model.idError} hint={ROLE_ID_HINT} label="ID">
              <TextInput mono {...fields!.id} />
            </Field>
          )}
          <Field label="Description">
            <TextInput {...fields!.description} />
          </Field>
          {permissionGroups(model.permissions).map(({ group, rows }) => (
            <section className="t-details-group" key={group}>
              <h3 className="t-group-name">{group}</h3>
              <div className="t-toggle-list">
                {rows.map(({ permission, checked, toggle }) => <Toggle action={toggle} checked={checked} key={permission.id} note={permission.description || undefined} />)}
              </div>
            </section>
          ))}
          {model.error && <p className="t-error" role="alert">{model.error}</p>}
        </div>
      )}
    </Drawer>
  );
}

const SEARCHABLE_PERMISSIONS = 3;

function RolePermissions({ role, catalogue }: Readonly<{ role: Role; catalogue: readonly PermissionInfo[] }>) {
  const permissions = rolePermissions(catalogue, role);
  const filter = useFilter(permissions, (permission) => [permission.id, permission.label, permission.description]);
  return (
    <div className="t-page">
      <p className="t-copy-line">{role.description}</p>
      {permissions.length > SEARCHABLE_PERMISSIONS && <FilterRow filter={filter} label="Search permissions" placeholder="Search by permission or description" plain />}
      {filter.rows.length === 0
        ? <NoMatches filter={filter} noun="permissions" />
        : <Details className="t-details-code" items={filter.rows.map((permission) => ({ label: permission.id, value: permission.description ? <><strong>{permission.label}</strong> · {permission.description}</> : <Ghost>No description recorded for this permission.</Ghost> }))} label="Permissions" />}
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
      <Panel flush head={<output aria-live="polite" className="t-panel-note">{model.saveStatus}</output>} name="Session events">
        <Table columns={columns} empty={<Empty title="No games" />} label="Session event subscriptions" loading={model.state === "loading"} rowKey={(game) => game.id} rows={model.games} />
      </Panel>
      <Panel name="Game invitations">
        {model.state === "loading" ? <SkeletonRows label="Loading invitation preferences" rows={2} /> : <div className="t-toggle-list">
          <Toggle action={model.toggle("invitation.broadcast", "Invitations sent to everyone")} checked={Boolean(model.subscriptions["invitation.broadcast"])} />
          <Toggle action={model.toggle("invitation.direct", "Invitations sent directly to me")} checked={Boolean(model.subscriptions["invitation.direct"])} />
        </div>}
      </Panel>
      <Panel>
        <div className="t-delivery">
          <strong>Delivery channel</strong>
          <State kind="ok" label="Telegram linked" />
        </div>
      </Panel>
    </Page>
  );
}
