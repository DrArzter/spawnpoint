import { useEffect, useState, type ReactNode } from "react";

import type { AccessInvitation } from "../../api/contract";
import type { Action } from "../../core/actions";
import type { AccessModel, CandidateRow, InvitationsModel, MemberRow, NotificationsModel, RoleChoice, RoleEditorModel, RolesModel, UsersModel } from "../../core/models";
import { invitationStatus, type StatusDescriptor } from "../../core/status";
import { Icon } from "../../icons";
import { permissionGroups, ROLE_ID_HINT, roleFormFields, permissionRows, rolePermissions } from "../../core/roles";
import type { Member, PermissionInfo, Role } from "../../model";
import { ConfirmationDialog } from "./Dialogs";
import { providerIcon, providerName } from "./providers";
import { ActionButton } from "./ui/ActionButton";
import { Ago } from "./ui/Ago";
import { Card } from "./ui/Card";
import { Chip } from "./ui/Chip";
import { Decision } from "./ui/Decision";
import { DetailList, shortDateTime } from "./ui/DetailList";
import { Empty, LoadError } from "./ui/Empty";
import { Checkbox, Field, Select, TextInput, Toggle } from "./ui/Fields";
import { Grid } from "./ui/Grid";
import { Indicator } from "./ui/Indicator";
import { ListColumn, ListItemIcon, ListItemPerson, type ListGroup } from "./ui/ListColumn";
import { Notice } from "./ui/Notice";
import { Overflow } from "./ui/Overflow";
import { PageHeader, type Crumb } from "./ui/PageHeader";
import { Person } from "./ui/Person";
import { SidePanel } from "./ui/SidePanel";
import { Skeleton, SkeletonGroup } from "./ui/Skeleton";
import { SplitPage } from "./ui/SplitPage";
import { Status } from "./ui/Status";
import { Table, type Column } from "./ui/Table";
import { TrackList, TrackTitle } from "./ui/TrackList";
import { t } from "../../i18n";

/*
 * Access (spec §6.5). The tab is core's route; which request, person or
 * invitation the pane shows is the skin's own, kept in the address after the
 * tab (#/access/users/people/<id>), which core's router ignores.
 */

type Group = "requests" | "people" | "invitations";
type Selection = Readonly<{ group: Group; id: string | null }> | null;

const USERS = "#/access/users";
const groupHref = (group: Group) => `${USERS}/${group}`;
const itemHref = (group: Group, id: string) => `${USERS}/${group}/${encodeURIComponent(id)}`;

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
    { id: `${game.id}.started`, label: t("access.gameDisplayNameStarted", { gameDisplayName: game.displayName }) },
    { id: `${game.id}.stopped`, label: t("access.gameDisplayNameStopped", { gameDisplayName: game.displayName }) },
  ]),
  { id: "invitation.broadcast", label: t("access.invitationsSentEveryone") },
  { id: "invitation.direct", label: t("access.invitationsSentDirectlyMe") },
];

export function Access({ model }: Readonly<{ model: AccessModel }>) {
  const selection = useSelection();
  const users = model.users;
  const candidates = users.candidates.status === "ready" ? users.candidates.value : [];
  const invitations = users.invitations?.list.status === "ready" ? users.invitations.list.value : [];
  const chosen = model.tab === "users" ? selection : null;
  const request = chosen?.group === "requests" ? candidates.find((row) => row.id === chosen.id) : undefined;
  const person = chosen?.group === "people" ? users.members.find((row) => row.member.id === chosen.id) : undefined;
  const invitation = chosen?.group === "invitations" ? invitations.find((row) => row.invitation.id === chosen.id) : undefined;
  const detail = request !== undefined || person !== undefined || invitation !== undefined;

  let pane: ReactNode;
  if (model.tab === "roles") pane = <RolesPane catalogue={model.catalogue} model={model.roles} users={users} />;
  else if (model.tab === "notifications") pane = <NotificationsPane model={model.notifications} />;
  else if (request) pane = <RequestPane catalogue={model.catalogue} roles={users.roles} row={request} />;
  else if (person) pane = <PersonPane catalogue={model.catalogue} roles={users.roles} row={person} />;
  else if (invitation) pane = <InvitationPane row={invitation} />;
  else pane = <UsersPane model={users} />;

  return (
    <>
      {/* Every pane stands alone under 1024px: the Users pane is the page there, and a detail pane returns to it (spec §6.5). */}
      <SplitPage list={<AccessList model={model} selection={detail ? chosen : null} />} selected>{pane}</SplitPage>
      {users.managed && <LinkedAccountsPanel close={users.closeManaged} member={users.managed} />}
      <ConfirmationDialog model={users.deletion} />
    </>
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
  const invitations = (users.invitations?.list.status === "ready" ? users.invitations.list.value : []).filter((row) => match(row.invitation.deliveryEmail ?? t("access.oneTimeLink")));
  const on = Object.values(model.notifications.subscriptions).filter(Boolean).length;
  const groups: ListGroup[] = [
    { id: "users", items: <ListItemIcon current={model.tab === "users" && selection === null} href={USERS} icon="group" name={t("access.allUsers")} /> },
    ...(candidates.length > 0 ? [{
      id: "requests",
      label: t("access.requests"),
      end: <span>{candidates.length}</span>,
      items: candidates.map((row) => <ListItemPerson account={row.account} accountIcon={providerIcon(row.candidate.platform)} current={current("requests", row.id)} href={itemHref("requests", row.id)} key={row.id} meta={<Ago at={row.candidate.requestedAt ?? row.candidate.firstSeenAt} />} name={row.candidate.displayName} photoUrl={row.candidate.photoUrl} tone="request" />),
    }] : []),
    {
      id: "people",
      label: t("access.people"),
      end: <span>{members.length}</span>,
      items: members.map((row) => <ListItemPerson account={firstAccount(row.member)} accountIcon={row.member.links[0] ? providerIcon(row.member.links[0].kind) : undefined} current={current("people", row.member.id)} href={itemHref("people", row.member.id)} key={row.member.id} meta={<Chip>{roleName(row.member.roleId)}</Chip>} name={row.member.name} photoUrl={row.member.photoUrl} />),
    },
    ...(invitations.length > 0 ? [{
      id: "invitations",
      label: t("access.invitations"),
      end: <span>{invitations.length}</span>,
      items: invitations.map((row) => <ListItemPerson current={current("invitations", row.invitation.id)} href={itemHref("invitations", row.invitation.id)} key={row.invitation.id} meta={<Ago at={row.invitation.createdAt} />} name={recipientOf(row.invitation)} tone="request" />),
    }] : []),
    {
      id: "settings",
      label: t("access.settings"),
      items: <>
        <ListItemIcon current={model.tab === "roles"} href="#/access/roles" icon="admin_panel_settings" meta={<span>{model.roleCount}</span>} name={t("access.roles")} />
        <ListItemIcon current={model.tab === "notifications"} href="#/access/notifications" icon="notifications" meta={<span>{t("access.subscriptionsOn", { count: on })}</span>} name={t("access.myNotifications")} />
      </>,
    },
  ];
  return <ListColumn filter={{ value: filter, set: setFilter, placeholder: t("access.filterPeople") }} groups={groups} label={t("common.access")} />;
}

function firstAccount(member: Member): string | undefined {
  const [first, ...rest] = member.links;
  if (!first) return undefined;
  return rest.length > 0 ? `${first.value} +${rest.length}` : first.value;
}

const recipientOf = (invitation: AccessInvitation) => invitation.deliveryEmail ?? t("access.oneTimeLink");


function RoleSelect({ label, choice, onChange }: Readonly<{ label: string; choice: RoleChoice; onChange: (roleId: string) => void }>) {
  return <Select aria-label={label} disabled={choice.disabled} inline onChange={(event) => onChange(event.target.value)} options={[...choice.options]} value={choice.value} />;
}

const ACCESS: Crumb = { label: t("common.access"), href: USERS };

// --- the default Users pane: every Users decision in one render -------------------

function UsersPane({ model }: Readonly<{ model: UsersModel }>) {
  const candidates = model.candidates;
  const requestColumns: Column<CandidateRow>[] = [
    { id: "person", header: t("common.person"), kind: "lead", render: (row) => <a href={itemHref("requests", row.id)}><Person detail={row.account} detailIcon={providerIcon(row.candidate.platform)} name={row.candidate.displayName} photoUrl={row.candidate.photoUrl} tone="request" /></a> },
    { id: "requested", header: t("common.requested"), render: (row) => <Ago at={row.candidate.requestedAt ?? row.candidate.firstSeenAt} /> },
    { id: "role", header: t("access.role"), render: (row) => <RoleSelect choice={row.role} label={t("access.roleCandidateDisplayName", { candidateDisplayName: row.candidate.displayName })} onChange={row.setRoleId} /> },
    { id: "actions", header: t("common.actions"), kind: "act", render: (row) => <Decision approve={row.approve} dismiss={row.dismiss} /> },
  ];
  const peopleColumns: Column<MemberRow>[] = [
    { id: "person", header: t("common.person"), kind: "lead", render: (row) => <a href={itemHref("people", row.member.id)}><Person name={row.member.name} photoUrl={row.member.photoUrl} /></a> },
    { id: "accounts", header: t("access.accounts"), kind: "wide", render: (row) => firstAccount(row.member) ?? <span className="c-faint">—</span> },
    { id: "role", header: t("access.role"), render: (row) => <RoleSelect choice={row.role} label={t("access.roleCandidateDisplayName", { candidateDisplayName: row.member.name })} onChange={row.setRoleId} /> },
    { id: "actions", header: t("common.actions"), kind: "act", render: (row) => <Overflow actions={row.remove ? [row.linkedAccounts, row.remove] : [row.linkedAccounts]} label={t("common.actionsMemberName", { memberName: row.member.name })} size="sm" /> },
  ];
  const showRequests = candidates.status !== "ready" || candidates.value.length > 0;
  return (
    <>
      <PageHeader count={model.members.length} title={t("access.users")} trail={[ACCESS]} />
      <Grid fill kind="stack">
        {showRequests && (
          <Card body="flush" count={candidates.status === "ready" ? candidates.value.length : undefined} title={t("access.requests")}>
            {candidates.status === "error"
              ? <LoadError error={candidates.error} kind={candidates.kind} retry={candidates.retry} size="sm" title={t("common.requestsCouldNotLoaded")} verb={t("common.readRequests")} />
              : <Table arrivals columns={requestColumns} label={t("access.requests")} loading={candidates.status === "loading"} rowKey={(row) => row.id} rows={candidates.status === "ready" ? candidates.value : []} />}
          </Card>
        )}
        <Card body="flush" count={model.members.length} fill title={t("access.people")}>
          <Table arrivals columns={peopleColumns} empty={<Empty icon="group" size="sm" title={t("access.noPeople")} />} label={t("access.people")} rowKey={(row) => row.member.id} rows={model.members} />
        </Card>
        {model.invitations && <InviteCard model={model.invitations} />}
        {model.invitations && <InvitationsCard model={model.invitations} />}
      </Grid>
    </>
  );
}

function InviteCard({ model }: Readonly<{ model: InvitationsModel }>) {
  return (
    <Card title={t("access.inviteSpawnpoint")}>
      <form className="c-access-invite" onSubmit={(event) => { event.preventDefault(); if (!model.create.disabled && !model.create.busy) model.create.run(); }}>
        {model.emailMode && (
          <Field label={t("common.email")}>
            <TextInput autoComplete="email" onChange={(event) => model.setEmail(event.target.value)} type="email" value={model.email} />
          </Field>
        )}
        {/* Until the sign-in options answer, the field's place is held, so the card does not grow under the reader. */}
        {model.emailMode === null && (
          <SkeletonGroup flow>
            <Field label={t("common.email")}>
              <Skeleton height="var(--c-field)" />
            </Field>
          </SkeletonGroup>
        )}
        <ActionButton action={model.create} size="sm" />
      </form>
      {model.issued && (
        <div className="c-access-issued">
          <div className="c-access-invite">
            <Field label={t("access.invitationLink")}>
              <TextInput mono onFocus={(event) => event.currentTarget.select()} readOnly value={model.issued.url} />
            </Field>
            <ActionButton action={model.issued.copy} />
          </div>
          <p className="c-line">{t("access.copyLinkNowShown")}</p>
        </div>
      )}
    </Card>
  );
}

function InvitationsCard({ model }: Readonly<{ model: InvitationsModel }>) {
  const list = model.list;
  type Row = Readonly<{ invitation: AccessInvitation; revoke: Action | null }>;
  const columns: Column<Row>[] = [
    { id: "recipient", header: t("access.recipient"), kind: "lead", render: (row) => <a href={itemHref("invitations", row.invitation.id)}>{recipientOf(row.invitation)}</a> },
    { id: "status", header: t("common.status"), render: (row) => <Status status={invitationStatus(row.invitation.status)} /> },
    { id: "created", header: t("common.created"), render: (row) => <Ago at={row.invitation.createdAt} /> },
    { id: "expires", header: t("access.expires"), kind: "wide", render: (row) => <DateTime at={row.invitation.expiresAt} /> },
    { id: "actions", header: t("common.actions"), kind: "act", render: (row) => row.revoke && <ActionButton action={row.revoke} size="sm" /> },
  ];
  return (
    <Card body="flush" count={list.status === "ready" ? list.value.length : undefined} title={t("access.invitations")}>
      {list.status === "error"
        ? <LoadError error={list.error} kind={list.kind} retry={list.retry} size="sm" title={t("access.invitationsCouldNotLoaded2")} verb={t("common.readInvitations")} />
        : <Table arrivals columns={columns} empty={<Empty icon="mail" size="sm" title={t("access.noInvitations")} />} label={t("access.invitations")} loading={list.status === "loading"} rowKey={(row) => row.invitation.id} rows={list.status === "ready" ? list.value : []} />}
    </Card>
  );
}

function DateTime({ at }: Readonly<{ at: string | null }>) {
  const text = shortDateTime(at);
  return text === null ? <span className="c-faint">—</span> : <time dateTime={at!}>{text}</time>;
}

// --- detail panes -------------------------------------------------------------------

function Permissions({ role, catalogue }: Readonly<{ role: Role | undefined; catalogue: readonly PermissionInfo[] }>) {
  if (!role) return null;
  return (
    <Card count={role.permissions.length} title={t("access.roleNamePermissions", { roleName: role.name })} titleTip={role.description}>
      <PermissionList catalogue={catalogue} role={role} />
    </Card>
  );
}

function PermissionList({ role, catalogue }: Readonly<{ role: Role; catalogue: readonly PermissionInfo[] }>) {
  return (
    <ul className="c-perms">
      {rolePermissions(catalogue, role).map((permission) => (
        <li className="c-perm" key={permission.id}>
          <Icon name="check" size={18} />
          <PermissionName permission={permission} />
        </li>
      ))}
    </ul>
  );
}

/** The catalogue's label, with its sentence in the tooltip; the id stays the accessible fallback for a permission the catalogue lacks. */
function PermissionName({ permission }: Readonly<{ permission: PermissionInfo }>) {
  return <span data-tip={permission.description || undefined} tabIndex={permission.description ? 0 : undefined /* NOSONAR focusable tooltip trigger */} title={permission.id}>{permission.label}</span>;
}

function RequestPane({ row, roles, catalogue }: Readonly<{ row: CandidateRow; roles: readonly Role[]; catalogue: readonly PermissionInfo[] }>) {
  const { candidate } = row;
  return (
    <>
      <PageHeader
        actions={<>
          <RoleSelect choice={row.role} label={t("access.roleApproval")} onChange={row.setRoleId} />
          <ActionButton action={row.approve} variant="primary" />
          <ActionButton action={row.dismiss} />
        </>}
        after={<Status status={{ kind: "pending", label: t("access.waiting") }} variant="pill" />}
        title={candidate.displayName}
        trail={[ACCESS, { label: t("access.requests"), href: groupHref("requests") }]}
      />
      <Grid kind="detail">
        <Card body="kv" title={t("access.request")}>
          <DetailList columns="fit" details={[
            { label: t("common.account"), value: { type: "text", text: row.account } },
            { label: t("access.provider"), value: { type: "text", text: providerName(candidate.platform) } },
            { label: t("common.requested"), value: { type: "time", at: candidate.requestedAt ?? candidate.firstSeenAt } },
          ]} />
        </Card>
        <Permissions catalogue={catalogue} role={roles.find((role) => role.id === row.role.value)} />
      </Grid>
    </>
  );
}

function PersonPane({ row, roles, catalogue }: Readonly<{ row: MemberRow; roles: readonly Role[]; catalogue: readonly PermissionInfo[] }>) {
  return (
    <>
      <PageHeader
        actions={<>
          <RoleSelect choice={row.role} label={t("access.role")} onChange={row.setRoleId} />
          <ActionButton action={row.linkedAccounts} />
          {row.remove && <ActionButton action={row.remove} />}
        </>}
        title={row.member.name}
        trail={[ACCESS, { label: t("access.people"), href: groupHref("people") }]}
      />
      <Grid kind="detail">
        <Card body="flush" count={row.member.links.length} title={t("access.linkedAccounts")}>
          <LinkedAccountList member={row.member} />
        </Card>
        <Permissions catalogue={catalogue} role={roles.find((role) => role.id === row.role.value)} />
      </Grid>
    </>
  );
}

function LinkedAccountList({ member }: Readonly<{ member: Member }>) {
  return (
    <TrackList
      empty={<Empty icon="link" size="sm" title={t("access.noLinkedAccounts")} />}
      label={t("access.memberNameLinkedAccounts", { memberName: member.name })}
      rowKey={(link) => link.id}
      rows={member.links}
      tracks={[
        { id: "provider", header: t("access.provider"), width: "auto", kind: "plain", render: (link) => <span className="c-access-provider"><Icon name={providerIcon(link.kind)} size={18} /><span>{providerName(link.kind)}</span></span> },
        { id: "account", header: t("common.account"), width: "minmax(0, 1fr)", kind: "stack", render: (link) => <TrackTitle title={<span className="c-mono" title={link.value}>{link.value}</span>} /> },
        { id: "state", header: t("common.state"), width: "auto", kind: "optional", render: (link) => <Status status={link.verified ? { kind: "ok", label: t("common.verified") } : { kind: "warning", label: t("access.unverified") }} /> },
      ]}
    />
  );
}

function LinkedAccountsPanel({ member, close }: Readonly<{ member: Member; close: Action }>) {
  return (
    <SidePanel cancel={close} title={t("access.memberNameLinkedAccounts2", { memberName: member.name })}>
      <LinkedAccountList member={member} />
    </SidePanel>
  );
}

const deliveries: Readonly<Record<AccessInvitation["delivery"], StatusDescriptor | null>> = {
  not_requested: null,
  pending: { kind: "pending", label: t("access.emailPending") },
  sent: { kind: "ok", label: t("access.emailSent") },
  failed: { kind: "error", label: t("access.emailFailed") },
};

function InvitationPane({ row }: Readonly<{ row: Readonly<{ invitation: AccessInvitation; revoke: Action | null }> }>) {
  const { invitation } = row;
  const delivery = deliveries[invitation.delivery];
  return (
    <>
      <PageHeader
        actions={row.revoke && <ActionButton action={row.revoke} />}
        after={<Status status={invitationStatus(invitation.status)} variant="pill" />}
        title={recipientOf(invitation)}
        trail={[ACCESS, { label: t("access.invitations"), href: groupHref("invitations") }]}
      />
      <Card body="kv" title={t("access.invitation")}>
        <DetailList columns="fit" details={[
          { label: t("access.delivery"), value: delivery ? { type: "status", status: delivery } : { type: "text", text: t("access.oneTimeLink") } },
          { label: t("common.created"), value: { type: "time", at: invitation.createdAt } },
          { label: t("access.expires"), value: { type: "time", at: invitation.expiresAt } },
          { label: t("access.used"), value: invitation.usedAt ? { type: "time", at: invitation.usedAt } : { type: "absent", text: "—" } },
        ]} />
      </Card>
    </>
  );
}

// --- roles and notifications ------------------------------------------------------

function RolesPane({ model, users, catalogue }: Readonly<{ model: RolesModel; users: UsersModel; catalogue: readonly PermissionInfo[] }>) {
  const state = model.roles;
  const roles = state.status === "ready" ? state.value : [];
  const permissions = permissionRows(catalogue, roles);
  const columns: Column<PermissionInfo>[] = [
    { id: "permission", header: t("access.permission"), kind: "lead", render: (permission) => <PermissionName permission={permission} /> },
    { id: "group", header: t("access.group"), kind: "wide", render: (permission) => <span className="c-faint">{permission.group}</span> },
    ...roles.map((role): Column<PermissionInfo> => {
      const read = model.read(role);
      return {
        id: role.id,
        header: role.name,
        className: "c-access-cell",
        // The button says what it opens; the count is labelled for a screen reader, as its column header reads only the role.
        headerCell: <span className="c-access-role-head"><ActionButton action={{ ...read, label: role.name, icon: undefined }} name={t("access.roleNamePermissions", { roleName: role.name })} size="sm" variant="ghost" /><span aria-label={t("access.personCount", { count: role.holders })} className="c-faint" role="img">{role.holders}</span></span>,
        render: (permission) => role.permissions.includes(permission.id)
          ? <Indicator status={{ kind: "ok", label: t("access.granted") }} />
          : <span aria-label={t("access.notGranted")} className="c-faint" role="img">—</span>,
      };
    }),
  ];
  return (
    <>
      <PageHeader actions={<ActionButton action={model.create} variant="primary" />} count={state.status === "ready" ? roles.length : undefined} title={t("access.roles")} trail={[ACCESS]} />
      <Grid fill kind="stack">
        <Card body="flush" fill label={t("access.rolesPermissions")}>
          {state.status === "error"
            ? <LoadError error={state.error} kind={state.kind} retry={state.retry} title={t("access.rolesCouldNotLoaded2")} verb={t("access.readRoles")} />
            : <Table columns={columns} empty={<Empty icon="admin_panel_settings" size="sm" title={t("access.noRoles")} />} label={t("access.permissionsByRole")} loading={state.status === "loading"} rowKey={(permission) => permission.id} rows={permissions} variant="matrix" />}
        </Card>
        <Card title={t("access.defaultRole")}>
          <Field label={t("access.givenApproval")}>
            <Select aria-label={t("access.defaultRole")} disabled={model.defaultRole.choice.disabled} onChange={(event) => model.defaultRole.set(event.target.value)} options={[...model.defaultRole.choice.options]} value={model.defaultRole.choice.value} />
          </Field>
        </Card>
        <OwnerCard users={users} />
      </Grid>
      <ConfirmationDialog model={model.deletion} />
      {model.editor && <RoleEditorPanel model={model.editor} />}
      {model.reading && (
        <SidePanel actions={<><ActionButton action={model.remove(model.reading)} variant="danger" /><ActionButton action={model.edit(model.reading)} variant="primary" /></>} cancel={model.closeReading} title={t("access.roleNamePermissions", { roleName: model.reading.name })}>
          <div className="c-access-role">
            {model.reading.builtIn && <Chip>{t("access.builtIn")}</Chip>}
            <p className="c-line">{model.reading.description}</p>
          </div>
          <PermissionList catalogue={catalogue} role={model.reading} />
        </SidePanel>
      )}
    </>
  );
}

function RoleEditorPanel({ model }: Readonly<{ model: RoleEditorModel }>) {
  const fields = roleFormFields(model);
  return (
    <SidePanel actions={<ActionButton action={model.submit} variant="primary" />} cancel={model.cancel} title={model.title}>
      <Field label={t("common.name")}>
        <TextInput {...fields.name} />
      </Field>
      {model.mode === "create" && (
        <Field error={model.idError} hint={ROLE_ID_HINT} label="ID">
          <TextInput mono {...fields.id} />
        </Field>
      )}
      <Field label={t("access.description")}>
        <TextInput {...fields.description} />
      </Field>
      {permissionGroups(model.permissions).map(({ group, rows }) => (
        <fieldset className="c-role-group" key={group}>
          <legend>{group}</legend>
          <div className="c-perms">
            {rows.map(({ permission, checked, toggle }) => (
              <Checkbox actionId={toggle.id} checked={checked} disabled={toggle.disabled} hint={toggle.disabled && toggle.hint ? toggle.hint : permission.description || undefined} key={permission.id} label={permission.label} onChange={toggle.run} />
            ))}
          </div>
        </fieldset>
      ))}
      {model.error && <p className="c-field-error" role="alert">{model.error}</p>}
    </SidePanel>
  );
}

function OwnerCard({ users }: Readonly<{ users: UsersModel }>) {
  const bootstrap = users.bootstrap;
  const claimed = bootstrap.state === "claimed";
  return (
    <Card actions={claimed ? undefined : <Status status={{ kind: "warning", label: t("access.unclaimed") }} variant="pill" />} body={claimed ? "kv" : "pad"} title={t("access.initialOwner")}>
      {bootstrap.state === "claimed" ? (
        <DetailList columns="fit" details={[
          { label: t("access.owner"), value: { type: "text", text: users.members.find((row) => row.member.id === bootstrap.ownerId)?.member.name ?? bootstrap.ownerId } },
          ...(bootstrap.telegramId === null ? [] : [{ label: "Telegram", value: { type: "text" as const, text: bootstrap.telegramId, mono: true } }]),
          { label: t("access.claimed"), value: { type: "time", at: bootstrap.claimedAt } },
        ]} />
      ) : (
        <div className="c-access-owner">
          {users.bootstrapDescription && <p className="c-line">{users.bootstrapDescription}</p>}
          {bootstrap.telegramId && <span className="c-access-owner-id"><span className="c-faint">{t("access.telegramID")}</span><span className="c-mono">{bootstrap.telegramId}</span></span>}
        </div>
      )}
    </Card>
  );
}

function NotificationsPane({ model }: Readonly<{ model: NotificationsModel }>) {
  const rows = notificationRows(model);
  return (
    <>
      <PageHeader title={t("access.myNotifications")} trail={[ACCESS]} />
      {model.state === "error" && <Notice notice={{ id: "notifications", tone: "error", title: t("access.subscriptionsCouldNotLoaded"), description: model.error, action: model.retry ?? undefined }} />}
      <Card body="flush" fill label={t("access.myNotifications")}>
        <TrackList
          label={t("common.notifications")}
          loading={model.state === "loading"}
          rowKey={(row) => row.id}
          rows={rows}
          tracks={[
            { id: "notification", header: t("access.notification"), width: "minmax(0, 1fr)", kind: "stack", lines: 1, render: (row) => <TrackTitle title={row.label} /> },
            { id: "subscribed", header: t("access.subscribed"), width: "auto", kind: "end", render: (row) => <Toggle action={model.toggle(row.id, row.label)} checked={Boolean(model.subscriptions[row.id])} /> },
          ]}
        />
        <output aria-live="polite" className="c-sr">{model.saveStatus}</output>
      </Card>
    </>
  );
}
