import { useEffect, useState, type ReactNode } from "react";

import type { AccessInvitation } from "../../api/contract";
import type { Action } from "../../core/actions";
import type { AccessModel, CandidateRow, ConfirmationModel, InvitationsModel, MemberRow, NotificationsModel, RolesModel, UsersModel } from "../../core/models";
import type { StatusDescriptor } from "../../core/status";
import { Icon } from "../../icons";
import { describePermission } from "../../lib/permissions";
import type { Member, Role } from "../../model";
import { ConfirmationDialog } from "./Dialogs";
import { providerIcon, providerName } from "./providers";
import { ActionButton } from "./ui/ActionButton";
import { Ago } from "./ui/Ago";
import { Card } from "./ui/Card";
import { Chip } from "./ui/Chip";
import { DetailList, shortDateTime } from "./ui/DetailList";
import { Empty, LoadError } from "./ui/Empty";
import { Field, Select, TextInput, Toggle } from "./ui/Fields";
import { Grid } from "./ui/Grid";
import { Indicator } from "./ui/Indicator";
import { ListColumn, ListItemPerson, type ListGroup } from "./ui/ListColumn";
import { Notice } from "./ui/Notice";
import { PageHeader, type Crumb } from "./ui/PageHeader";
import { Person } from "./ui/Person";
import { SidePanel } from "./ui/SidePanel";
import { SkeletonRows } from "./ui/Skeleton";
import { Status } from "./ui/Status";
import { Table, type Column } from "./ui/Table";
import { TrackList, TrackTitle } from "./ui/TrackList";

/*
 * Access (spec §6.5). The tab is core's route; which request, person or
 * invitation the pane shows is the skin's own, kept in the address after the
 * tab (#/access/users/people/<id>), which core's router ignores.
 */

// M3 (slice C) adds these; until then the model gives neither and nothing is drawn.
type Removable = MemberRow & Readonly<{ remove?: Action | null }>;
type WithDeletion = UsersModel & Readonly<{ deletion?: ConfirmationModel | null }>;

type Group = "requests" | "people" | "invitations";
type Selection = Readonly<{ group: Group; id: string | null }> | null;

const USERS = "#/access/users";
const groupHref = (group: Group) => `${USERS}/${group}`;
const itemHref = (group: Group, id: string) => `${USERS}/${group}/${encodeURIComponent(id)}`;
const candidateId = (row: CandidateRow) => `${row.candidate.platform}:${row.candidate.platformUserId}`;

function readSelection(): Selection {
  if (typeof window === "undefined") return null;
  const [page, tab, group, id] = window.location.hash.replace(/^#\/?/, "").split("?")[0]!.split("/");
  if (page !== "access" || tab !== "users" || (group !== "requests" && group !== "people" && group !== "invitations")) return null;
  try {
    return { group, id: id ? decodeURIComponent(id) : null };
  } catch {
    return { group, id: null };
  }
}

function useSelection(): Selection {
  const [selection, setSelection] = useState<Selection>(readSelection);
  useEffect(() => {
    const onHash = () => setSelection(readSelection());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return selection;
}

const notificationRows = (model: NotificationsModel) => [
  ...model.games.flatMap((game) => [
    { id: `${game.id}.started`, label: `${game.displayName} started` },
    { id: `${game.id}.stopped`, label: `${game.displayName} stopped` },
  ]),
  { id: "invitation.broadcast", label: "Invitations sent to everyone" },
  { id: "invitation.direct", label: "Invitations sent directly to me" },
];

export function Access({ model }: Readonly<{ model: AccessModel }>) {
  const selection = useSelection();
  const users = model.users;
  const candidates = users.candidates.status === "ready" ? users.candidates.value : [];
  const invitations = users.invitations?.list.status === "ready" ? users.invitations.list.value : [];
  const chosen = model.tab === "users" ? selection : null;
  const request = chosen?.group === "requests" ? candidates.find((row) => candidateId(row) === chosen.id) : undefined;
  const person = chosen?.group === "people" ? users.members.find((row) => row.member.id === chosen.id) : undefined;
  const invitation = chosen?.group === "invitations" ? invitations.find((row) => row.invitation.id === chosen.id) : undefined;
  const detail = request !== undefined || person !== undefined || invitation !== undefined;

  let pane: ReactNode;
  if (model.tab === "roles") pane = <RolesPane model={model.roles} users={users} />;
  else if (model.tab === "notifications") pane = <NotificationsPane model={model.notifications} />;
  else if (request) pane = <RequestPane roles={users.roles} rolesLoading={users.rolesLoading} row={request} />;
  else if (person) pane = <PersonPane roles={users.roles} rolesLoading={users.rolesLoading} row={person} />;
  else if (invitation) pane = <InvitationPane row={invitation} />;
  else pane = <UsersPane model={users} />;

  const deletion = (users as WithDeletion).deletion ?? null;
  return (
    <div className="c-access">
      <AccessList model={model} selection={detail ? chosen : null} />
      <div className="c-access-pane">
        <div className="c-page">{pane}</div>
      </div>
      {users.managed && <LinkedAccountsPanel close={users.closeManaged} member={users.managed} />}
      {deletion && <ConfirmationDialog model={deletion} />}
    </div>
  );
}

/** The list column: navigation only, no Actions (they live in the pane). */
function AccessList({ model, selection }: Readonly<{ model: AccessModel; selection: Selection }>) {
  const [filter, setFilter] = useState("");
  const users = model.users;
  const match = (...values: readonly (string | null | undefined)[]) => filter.trim() === "" || values.some((value) => value?.toLowerCase().includes(filter.trim().toLowerCase()));
  const current = (group: Group, id: string) => selection?.group === group && selection.id === id;
  const roleName = (id: string) => users.roles.find((role) => role.id === id)?.name ?? id;
  const candidates = (users.candidates.status === "ready" ? users.candidates.value : []).filter((row) => match(row.candidate.displayName, row.account));
  const members = users.members.filter((row) => match(row.member.name, ...row.member.links.map((link) => link.value)));
  const invitations = (users.invitations?.list.status === "ready" ? users.invitations.list.value : []).filter((row) => match(row.invitation.deliveryEmail ?? "One-time link"));
  const on = Object.values(model.notifications.subscriptions).filter(Boolean).length;
  const groups: ListGroup[] = [
    { id: "users", items: <ListItemPerson current={model.tab === "users" && selection === null} href={USERS} name="All users" tone="person" /> },
    ...(candidates.length > 0 ? [{
      id: "requests",
      label: "Requests",
      end: <span>{candidates.length}</span>,
      items: candidates.map((row) => <ListItemPerson account={row.account} accountIcon={providerIcon(row.candidate.platform)} current={current("requests", candidateId(row))} href={itemHref("requests", candidateId(row))} key={candidateId(row)} meta={<Ago at={row.candidate.requestedAt ?? row.candidate.firstSeenAt} />} name={row.candidate.displayName} photoUrl={row.candidate.photoUrl} tone="request" />),
    }] : []),
    {
      id: "people",
      label: "People",
      end: <span>{members.length}</span>,
      items: members.map((row) => <ListItemPerson account={firstAccount(row.member)} accountIcon={row.member.links[0] ? providerIcon(row.member.links[0].kind) : undefined} current={current("people", row.member.id)} href={itemHref("people", row.member.id)} key={row.member.id} meta={<Chip>{roleName(row.roleId)}</Chip>} name={row.member.name} />),
    },
    ...(invitations.length > 0 ? [{
      id: "invitations",
      label: "Invitations",
      end: <span>{invitations.length}</span>,
      items: invitations.map((row) => <ListItemPerson current={current("invitations", row.invitation.id)} href={itemHref("invitations", row.invitation.id)} key={row.invitation.id} meta={<Ago at={row.invitation.createdAt} />} name={recipientOf(row.invitation)} tone="request" />),
    }] : []),
    {
      id: "settings",
      label: "Settings",
      items: <>
        <ListItemPerson current={model.tab === "roles"} href="#/access/roles" meta={<span>{model.roleCount}</span>} name="Roles" />
        <ListItemPerson current={model.tab === "notifications"} href="#/access/notifications" meta={<span>{on} on</span>} name="My notifications" />
      </>,
    },
  ];
  return <ListColumn filter={{ value: filter, set: setFilter, placeholder: "Filter people" }} groups={groups} label="Access" />;
}

function firstAccount(member: Member): string | undefined {
  const [first, ...rest] = member.links;
  if (!first) return undefined;
  return rest.length > 0 ? `${first.value} +${rest.length}` : first.value;
}

const recipientOf = (invitation: AccessInvitation) => invitation.deliveryEmail ?? "One-time link";

const invitationStatus: Readonly<Record<AccessInvitation["status"], StatusDescriptor>> = {
  PENDING: { kind: "pending", label: "Pending" },
  USED: { kind: "ok", label: "Used" },
  REVOKED: { kind: "off", label: "Revoked" },
  EXPIRED: { kind: "off", label: "Expired" },
};

function RoleSelect({ label, value, onChange, roles, disabled, excludeOwner = false }: Readonly<{ label: string; value: string; onChange: (roleId: string) => void; roles: readonly Role[]; disabled: boolean; excludeOwner?: boolean }>) {
  const offered = excludeOwner ? roles.filter((role) => role.id !== "owner" || role.id === value) : roles;
  const options = offered.length > 0 ? offered.map((role) => ({ value: role.id, label: role.name })) : [{ value, label: value }];
  return <Select aria-label={label} disabled={disabled || roles.length === 0} inline onChange={(event) => onChange(event.target.value)} options={options} value={value} />;
}

const ACCESS: Crumb = { label: "Access", href: USERS };

// --- the default Users pane: every Users decision in one render -------------------

function UsersPane({ model }: Readonly<{ model: UsersModel }>) {
  const blocked = model.rolesLoading;
  const candidates = model.candidates;
  const requestColumns: Column<CandidateRow>[] = [
    { id: "person", header: "Person", kind: "lead", render: (row) => <a href={itemHref("requests", candidateId(row))}><Person detail={row.account} detailIcon={providerIcon(row.candidate.platform)} name={row.candidate.displayName} photoUrl={row.candidate.photoUrl} tone="request" /></a> },
    { id: "requested", header: "Requested", render: (row) => <Ago at={row.candidate.requestedAt ?? row.candidate.firstSeenAt} /> },
    { id: "role", header: "Role", render: (row) => <RoleSelect disabled={blocked} excludeOwner label={`Role for ${row.candidate.displayName}`} onChange={row.setRoleId} roles={model.roles} value={row.roleId} /> },
    { id: "actions", header: "Actions", kind: "act", render: (row) => <><ActionButton action={row.approve} size="sm" /><ActionButton action={row.dismiss} size="sm" /></> },
  ];
  const peopleColumns: Column<MemberRow>[] = [
    { id: "person", header: "Person", kind: "lead", render: (row) => <a href={itemHref("people", row.member.id)}><Person name={row.member.name} /></a> },
    { id: "accounts", header: "Accounts", kind: "wide", render: (row) => firstAccount(row.member) ?? <span className="c-faint">—</span> },
    { id: "role", header: "Role", render: (row) => <RoleSelect disabled={blocked || row.changing} label={`Role for ${row.member.name}`} onChange={row.setRoleId} roles={model.roles} value={row.roleId} /> },
    { id: "actions", header: "Actions", kind: "act", render: (row) => { const remove = (row as Removable).remove; return <><ActionButton action={row.linkedAccounts} size="sm" />{remove && <ActionButton action={remove} size="sm" />}</>; } },
  ];
  const showRequests = candidates.status !== "ready" || candidates.value.length > 0;
  return (
    <>
      <PageHeader count={model.members.length} title="Users" trail={[ACCESS]} />
      <Grid kind="stack">
        {showRequests && (
          <Card body="flush" count={candidates.status === "ready" ? candidates.value.length : undefined} title="Requests">
            {candidates.status === "error"
              ? <LoadError error={candidates.error} kind={candidates.kind} retry={candidates.retry} size="sm" title="Requests could not be loaded" verb="read requests" />
              : <Table columns={requestColumns} label="Requests" loading={candidates.status === "loading"} rowKey={candidateId} rows={candidates.status === "ready" ? candidates.value : []} />}
          </Card>
        )}
        <Card body="flush" count={model.members.length} title="People">
          <Table columns={peopleColumns} empty={<Empty icon="group" size="sm" title="No people" />} label="People" rowKey={(row) => row.member.id} rows={model.members} />
        </Card>
        {model.invitations && <InviteCard model={model.invitations} />}
        {model.invitations && <InvitationsCard model={model.invitations} />}
      </Grid>
    </>
  );
}

function InviteCard({ model }: Readonly<{ model: InvitationsModel }>) {
  return (
    <Card title="Invite to Spawnpoint">
      <form className="c-access-invite" onSubmit={(event) => { event.preventDefault(); if (!model.create.disabled && !model.create.busy) model.create.run(); }}>
        {model.emailMode && (
          <Field label="Email">
            <TextInput autoComplete="email" onChange={(event) => model.setEmail(event.target.value)} type="email" value={model.email} />
          </Field>
        )}
        <ActionButton action={model.create} size="sm" />
      </form>
      {model.issued && (
        <div className="c-access-issued">
          <div className="c-access-invite">
            <Field label="Invitation link">
              <TextInput mono onFocus={(event) => event.currentTarget.select()} readOnly value={model.issued.url} />
            </Field>
            <ActionButton action={model.issued.copy} />
          </div>
          <p className="c-line">Copy this link now. It is shown once.</p>
        </div>
      )}
    </Card>
  );
}

function InvitationsCard({ model }: Readonly<{ model: InvitationsModel }>) {
  const list = model.list;
  type Row = Readonly<{ invitation: AccessInvitation; revoke: Action | null }>;
  const columns: Column<Row>[] = [
    { id: "recipient", header: "Recipient", kind: "lead", render: (row) => <a href={itemHref("invitations", row.invitation.id)}>{recipientOf(row.invitation)}</a> },
    { id: "status", header: "Status", render: (row) => <Status status={invitationStatus[row.invitation.status]} /> },
    { id: "created", header: "Created", render: (row) => <Ago at={row.invitation.createdAt} /> },
    { id: "expires", header: "Expires", kind: "wide", render: (row) => <DateTime at={row.invitation.expiresAt} /> },
    { id: "actions", header: "Actions", kind: "act", render: (row) => row.revoke && <ActionButton action={row.revoke} size="sm" /> },
  ];
  return (
    <Card body="flush" count={list.status === "ready" ? list.value.length : undefined} title="Invitations">
      {list.status === "error"
        ? <LoadError error={list.error} kind={list.kind} retry={list.retry} size="sm" title="Invitations could not be loaded" verb="read invitations" />
        : <Table columns={columns} empty={<Empty icon="mail" size="sm" title="No invitations" />} label="Invitations" loading={list.status === "loading"} rowKey={(row) => row.invitation.id} rows={list.status === "ready" ? list.value : []} />}
    </Card>
  );
}

function DateTime({ at }: Readonly<{ at: string | null }>) {
  const text = shortDateTime(at);
  return text === null ? <span className="c-faint">—</span> : <time dateTime={at!}>{text}</time>;
}

// --- detail panes -------------------------------------------------------------------

function Permissions({ role }: Readonly<{ role: Role | undefined }>) {
  if (!role) return null;
  return (
    <Card count={role.permissions.length} title={`${role.name} permissions`} titleTip={role.description}>
      <PermissionList permissions={role.permissions} />
    </Card>
  );
}

function PermissionList({ permissions }: Readonly<{ permissions: readonly string[] }>) {
  return (
    <ul className="c-perms">
      {[...permissions].sort((a, b) => a.localeCompare(b)).map((permission) => (
        <li className="c-perm" key={permission}>
          <Icon name="check" size={18} />
          <span className="c-mono" data-tip={describePermission(permission)} tabIndex={describePermission(permission) ? 0 : undefined}>{permission}</span>
        </li>
      ))}
    </ul>
  );
}

function RequestPane({ row, roles, rolesLoading }: Readonly<{ row: CandidateRow; roles: readonly Role[]; rolesLoading: boolean }>) {
  const { candidate } = row;
  return (
    <>
      <PageHeader
        actions={<>
          <RoleSelect disabled={rolesLoading} excludeOwner label="Role on approval" onChange={row.setRoleId} roles={roles} value={row.roleId} />
          <ActionButton action={row.approve} variant="primary" />
          <ActionButton action={row.dismiss} />
        </>}
        after={<Status status={{ kind: "pending", label: "Waiting" }} variant="pill" />}
        title={candidate.displayName}
        trail={[ACCESS, { label: "Requests", href: groupHref("requests") }]}
      />
      <Grid kind="detail">
        <Card body="kv" title="Request">
          <DetailList columns="fit" details={[
            { label: "Account", value: { type: "text", text: row.account } },
            { label: "Provider", value: { type: "text", text: providerName(candidate.platform) } },
            { label: "Requested", value: { type: "time", at: candidate.requestedAt ?? candidate.firstSeenAt } },
          ]} />
        </Card>
        <Permissions role={roles.find((role) => role.id === row.roleId)} />
      </Grid>
    </>
  );
}

function PersonPane({ row, roles, rolesLoading }: Readonly<{ row: MemberRow; roles: readonly Role[]; rolesLoading: boolean }>) {
  const remove = (row as Removable).remove;
  return (
    <>
      <PageHeader
        actions={<>
          <RoleSelect disabled={rolesLoading || row.changing} label="Role" onChange={row.setRoleId} roles={roles} value={row.roleId} />
          <ActionButton action={row.linkedAccounts} />
          {remove && <ActionButton action={remove} />}
        </>}
        title={row.member.name}
        trail={[ACCESS, { label: "People", href: groupHref("people") }]}
      />
      <Grid kind="detail">
        <Card body="flush" count={row.member.links.length} title="Linked accounts">
          <LinkedAccountList member={row.member} />
        </Card>
        <Permissions role={roles.find((role) => role.id === row.roleId)} />
      </Grid>
    </>
  );
}

function LinkedAccountList({ member }: Readonly<{ member: Member }>) {
  return (
    <TrackList
      empty={<Empty icon="link" size="sm" title="No linked accounts" />}
      label={`${member.name}: linked accounts`}
      rowKey={(link) => link.id}
      rows={member.links}
      tracks={[
        { id: "provider", header: "Provider", width: "auto", kind: "plain", render: (link) => <span className="c-access-provider"><Icon name={providerIcon(link.kind)} size={18} /><span>{providerName(link.kind)}</span></span> },
        { id: "account", header: "Account", width: "minmax(0, 1fr)", kind: "stack", render: (link) => <TrackTitle title={<span className="c-mono" title={link.value}>{link.value}</span>} /> },
        { id: "state", header: "State", width: "auto", kind: "optional", render: (link) => <Status status={link.verified ? { kind: "ok", label: "Verified" } : { kind: "warning", label: "Unverified" }} /> },
      ]}
    />
  );
}

function LinkedAccountsPanel({ member, close }: Readonly<{ member: Member; close: Action }>) {
  return (
    <SidePanel cancel={close} title={`${member.name} · Linked accounts`}>
      <LinkedAccountList member={member} />
    </SidePanel>
  );
}

const deliveries: Readonly<Record<AccessInvitation["delivery"], StatusDescriptor | null>> = {
  not_requested: null,
  pending: { kind: "pending", label: "Email pending" },
  sent: { kind: "ok", label: "Email sent" },
  failed: { kind: "error", label: "Email failed" },
};

function InvitationPane({ row }: Readonly<{ row: Readonly<{ invitation: AccessInvitation; revoke: Action | null }> }>) {
  const { invitation } = row;
  const delivery = deliveries[invitation.delivery];
  return (
    <>
      <PageHeader
        actions={row.revoke && <ActionButton action={row.revoke} />}
        after={<Status status={invitationStatus[invitation.status]} variant="pill" />}
        title={recipientOf(invitation)}
        trail={[ACCESS, { label: "Invitations", href: groupHref("invitations") }]}
      />
      <Card body="kv" title="Invitation">
        <DetailList columns="fit" details={[
          { label: "Delivery", value: delivery ? { type: "status", status: delivery } : { type: "text", text: "One-time link" } },
          { label: "Created", value: { type: "time", at: invitation.createdAt } },
          { label: "Expires", value: { type: "time", at: invitation.expiresAt } },
          { label: "Used", value: invitation.usedAt ? { type: "time", at: invitation.usedAt } : { type: "absent", text: "—" } },
        ]} />
      </Card>
    </>
  );
}

// --- roles and notifications ------------------------------------------------------

function RolesPane({ model, users }: Readonly<{ model: RolesModel; users: UsersModel }>) {
  const state = model.roles;
  const roles = state.status === "ready" ? state.value : [];
  const permissions = [...new Set(roles.flatMap((role) => role.permissions))].sort((a, b) => a.localeCompare(b));
  const holders = (role: Role) => users.members.filter((row) => row.roleId === role.id).length;
  const columns: Column<string>[] = [
    { id: "permission", header: "Permission", kind: "lead", render: (permission) => <span className="c-mono" data-tip={describePermission(permission)}>{permission}</span> },
    ...roles.map((role): Column<string> => {
      const read = model.read(role);
      return {
        id: role.id,
        header: role.name,
        className: "c-access-cell",
        // The button says what it opens; the count is labelled for a screen reader, as its column header reads only the role.
        headerCell: <span className="c-access-role-head"><ActionButton action={{ ...read, label: `${role.name} permissions`, icon: undefined }} size="sm" variant="ghost" /><span aria-label={`${holders(role)} ${holders(role) === 1 ? "person" : "people"}`} className="c-faint" role="img">{holders(role)}</span></span>,
        render: (permission) => role.permissions.includes(permission)
          ? <Indicator status={{ kind: "ok", label: "Granted" }} />
          : <span aria-label="Not granted" className="c-faint" role="img">—</span>,
      };
    }),
  ];
  return (
    <>
      <PageHeader count={state.status === "ready" ? roles.length : undefined} title="Roles" trail={[ACCESS]} />
      <Grid kind="stack">
        <Card body="flush" label="Roles and permissions">
          {state.status === "error"
            ? <LoadError error={state.error} kind={state.kind} retry={state.retry} title="Roles could not be loaded" verb="read roles" />
            : <Table columns={columns} empty={<Empty icon="admin_panel_settings" size="sm" title="No roles" />} label="Permissions by role" loading={state.status === "loading"} rowKey={(permission) => permission} rows={permissions} variant="matrix" />}
        </Card>
        <OwnerCard users={users} />
      </Grid>
      {model.reading && (
        <SidePanel cancel={model.closeReading} title={`${model.reading.name} permissions`}>
          <div className="c-access-role">
            {model.reading.system && <Chip>System</Chip>}
            <p className="c-line">{model.reading.description}</p>
          </div>
          <PermissionList permissions={model.reading.permissions} />
        </SidePanel>
      )}
    </>
  );
}

function OwnerCard({ users }: Readonly<{ users: UsersModel }>) {
  const bootstrap = users.bootstrap;
  const claimed = bootstrap.state === "claimed";
  return (
    <Card actions={<Status status={claimed ? { kind: "ok", label: "Claimed" } : { kind: "warning", label: "Unclaimed" }} variant="pill" />} body={claimed ? "kv" : "pad"} title="Initial owner">
      {bootstrap.state === "claimed" ? (
        <DetailList columns="fit" details={[
          { label: "Owner", value: { type: "text", text: users.members.find((row) => row.member.id === bootstrap.ownerId)?.member.name ?? bootstrap.ownerId } },
          { label: "Telegram", value: { type: "text", text: bootstrap.telegramId, mono: true } },
          { label: "Claimed", value: { type: "time", at: bootstrap.claimedAt } },
        ]} />
      ) : (
        <div className="c-access-owner">
          {users.bootstrapDescription && <p className="c-line">{users.bootstrapDescription}</p>}
          {bootstrap.telegramId && <span className="c-access-owner-id"><span className="c-faint">Your Telegram ID</span><span className="c-mono">{bootstrap.telegramId}</span></span>}
        </div>
      )}
    </Card>
  );
}

function NotificationsPane({ model }: Readonly<{ model: NotificationsModel }>) {
  const rows = notificationRows(model);
  return (
    <>
      <PageHeader title="My notifications" trail={[ACCESS]} />
      {model.state === "error" && <Notice notice={{ id: "notifications", tone: "error", title: "Subscriptions could not be loaded", description: model.error, action: model.retry ?? undefined }} />}
      <Card body="flush" label="My notifications">
        {model.state === "loading" ? <SkeletonRows columns={2} rows={rows.length} /> : (
          <TrackList
            label="Notifications"
            rowKey={(row) => row.id}
            rows={rows}
            tracks={[
              { id: "notification", header: "Notification", width: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle title={row.label} /> },
              { id: "subscribed", header: "Subscribed", width: "auto", kind: "end", render: (row) => <Toggle action={model.toggle(row.id, row.label)} checked={Boolean(model.subscriptions[row.id])} /> },
            ]}
          />
        )}
        <output aria-live="polite" className="c-sr">{model.saveStatus}</output>
      </Card>
    </>
  );
}
