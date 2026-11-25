import { useState } from "react";

import { useFilter } from "../../components/ui/Filter";
import type { AccessModel, CandidateRow, InvitationsModel, MemberRow, NotificationsModel, RoleChoice, RoleEditorModel, RolesModel, UsersModel } from "../../core/models";
import { Icon, type IconName } from "../../icons";
import { formatDateTime } from "../../lib/format";
import { permissionGroups, ROLE_ID_HINT, roleFormFields, protectedRoleName, rolePermissions } from "../../core/roles";
import type { Game, LinkKind, Member, PermissionInfo, Role } from "../../model";
import { ConfirmationDialog } from "./Dialogs";
import { Col, Details, Drawer, Empty, Field, FilterRow, Ghost, Indicator, Key, LoadError, NoMatches, Notice, Overflow, Page, Panel, Person, SelectInput, SkeletonRows, State, Table, Tabs, TextInput, Toggle, Verb } from "./ui";
import { invitationStatus } from "../../core/status";
import { t } from "../../i18n";

export function Access({ model }: Readonly<{ model: AccessModel }>) {
  return (
    <Page>
      <h1 className="visually-hidden">{t("common.access")}</h1>
      <Tabs label={t("access.accessSections")} onChange={model.setTab} options={[{ id: "users", label: t("access.users") }, { id: "roles", label: t("access.roles"), count: model.roleCount || undefined }, { id: "notifications", label: t("common.notifications") }]} value={model.tab} />
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
      label: t("access.user"),
      render: (row) => <Person detail={<>{row.account} · {row.since}</>} name={row.candidate.displayName} photoUrl={row.candidate.photoUrl} />,
    },
    { id: "role", label: t("access.role"), align: "end", width: "180px", render: (row) => <RoleSelect choice={row.role} label={t("access.roleCandidateDisplayName", { candidateDisplayName: row.candidate.displayName })} onChange={row.setRoleId} /> },
    { id: "verbs", label: t("common.actions"), verbs: true, width: "80px", render: (row) => <Overflow groups={[[row.approve, row.dismiss]]} label={t("common.actionsMemberName", { memberName: row.candidate.displayName })} size="small" /> },
  ];
  const memberColumns: readonly Col<MemberRow>[] = [
    { id: "user", label: t("access.user"), render: (row) => <Person name={row.member.name} photoUrl={row.member.photoUrl} /> },
    { id: "role", label: t("access.role"), align: "end", width: "180px", render: (row) => <RoleSelect choice={row.role} label={t("access.roleCandidateDisplayName", { candidateDisplayName: row.member.name })} onChange={row.setRoleId} /> },
    { id: "verbs", label: t("common.actions"), verbs: true, width: "80px", render: (row) => <Overflow groups={[[row.linkedAccounts], row.remove ? [row.remove] : []]} label={t("common.actionsMemberName", { memberName: row.member.name })} menu size="small" /> },
  ];
  const candidates = model.candidates;
  const managedRole = model.managed ? model.roles.find((role) => role.id === model.managed?.roleId)?.name ?? model.managed.roleId : "";

  return (
    <Page>
      {candidates.status === "error" && <LoadError state={candidates} title={t("access.accessRequestsCouldNotLoaded")} verb={t("common.readRequests")} />}

      {model.invitations && <Invitations model={model.invitations} />}

      <Panel flush name={t("common.accessRequests")}>
        <Table
          columns={candidateColumns}
          decision
          empty={<Empty title={t("access.noAccessRequests")} />}
          headless
          label={t("common.accessRequests")}
          loading={candidates.status === "loading"}
          rowKey={(row) => row.id}
          rows={candidates.status === "ready" ? candidates.value : []}
        />
      </Panel>

      <Panel flush name={t("access.identities")}>
        <Table columns={memberColumns} decision empty={<Empty title={t("access.noIdentities")} />} headless label={t("access.identitiesRoles")} loading={candidates.status === "loading"} rowKey={(row) => row.member.id} rows={model.members} />
      </Panel>

      <Panel
        flush
        head={<State kind={model.bootstrap.state === "claimed" ? "ok" : "warning"} label={model.bootstrap.state === "claimed" ? t("access.complete") : t("access.actionRequired")} />}
        name={t("access.initialOwner")}
      >
        <Details className="t-details-flush" items={[
          { label: t("access.telegramID2"), value: model.bootstrap.telegramId ? <code>{model.bootstrap.telegramId}</code> : t("access.setDeploymentConfiguration") },
          { label: t("access.role"), value: protectedRoleName(model.roles) ?? "—" },
          ...(model.bootstrap.state === "claimed" ? [{ label: t("access.claimed"), value: formatDateTime(model.bootstrap.claimedAt) }] : []),
        ]} label={t("access.initialOwner")} />
        <div className="t-panel-foot">
          <Key aria-expanded={showBootstrap} label={showBootstrap ? t("access.hideSetupSteps") : t("access.howFirstOwnerSet")} onClick={() => setShowBootstrap((value) => !value)} size="small" />
        </div>
        {showBootstrap && (
          <ol className="t-steps">
            <li>{t("access.setInitialOwnerTelegram")}</li>
            <li>{t("access.signThroughTelegramExact")}</li>
            <li>{t("access.spawnpointCreatesOwnerCloses")}</li>
            <li>{t("access.addGameNetworkAccounts")}</li>
          </ol>
        )}
      </Panel>

      <Drawer cancel={model.closeManaged} cancelLabel={t("common.close")} closeActionId={model.closeManaged.id} description={model.managed ? `${model.managed.name} · ${managedRole}` : undefined} onClose={model.closeManaged.run} open={model.managed !== null} title={t("access.linkedAccounts")}>
        {model.managed && <LinkedAccounts member={model.managed} />}
      </Drawer>

      <ConfirmationDialog model={model.deletion} />
    </Page>
  );
}

// A link either proves who you are, names you inside a game, or admits a
// device to the network; the grouping says which.
const linkProviders: Readonly<Record<LinkKind, { label: string; icon: IconName; purpose: string }>> = {
  telegram: { label: "Telegram", icon: "send", purpose: t("access.signIn") },
  email: { label: t("common.email"), icon: "mail", purpose: t("access.signIn") },
  google: { label: "Google", icon: "account_circle", purpose: t("access.signIn") },
  discord: { label: "Discord", icon: "group", purpose: t("access.signIn") },
  minecraft: { label: "Minecraft", icon: "sports_esports", purpose: t("access.gameIdentity") },
  factorio: { label: "Factorio", icon: "sports_esports", purpose: t("access.gameIdentity") },
  steam: { label: "Steam", icon: "sports_esports", purpose: t("access.gameIdentity") },
  zerotier: { label: "ZeroTier", icon: "hub", purpose: t("access.network") },
};

function LinkedAccounts({ member }: Readonly<{ member: Member }>) {
  const purposes = [t("access.signIn"), t("access.gameIdentity"), t("access.network")];
  return (
    <div className="t-page">
      {member.links.length === 0 && <Empty title={t("access.noLinkedAccounts")} />}
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
                  <Indicator kind={link.verified ? "ok" : "pending"} label={link.verified ? t("common.verified") : t("common.pendingVerification")} />
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
    <Panel name={t("access.inviteSpawnpoint")}>
      <form className="t-entry-form" onSubmit={(event) => { event.preventDefault(); model.create.run(); }}>
        {model.emailMode && (
          <Field label={t("access.inviteEmail")}>
            <TextInput autoComplete="email" onChange={(event) => model.setEmail(event.target.value)} placeholder="person@example.com" required type="email" value={model.email} />
          </Field>
        )}
        {model.emailMode === false && <p className="t-copy-line">{t("access.deploymentHasNoEmail")}</p>}
        <Verb action={model.create} className="t-entry-verb" tone="primary" type="submit" />
      </form>
      {model.issued && <div className="t-invite-link">
        <p>{model.issued.email ? t("access.oneTimeLinkEmailRecipient", { email: model.issued.email }) : t("access.oneTimeLinkNotEmailBound")} {t("access.copyLinkNowShown")}</p>
        <div className="t-invite-link-row">
          <Field label={t("access.invitationLink")}><TextInput mono onFocus={(event) => event.currentTarget.select()} readOnly value={model.issued.url} /></Field>
          <Verb action={model.issued.copy} />
        </div>
      </div>}
      {list.status === "error" && <LoadError state={list} title={t("access.invitationsCouldNotLoaded2")} verb={t("common.readInvitations")} />}
      {list.status === "loading" && <SkeletonRows label={t("access.loadingInvitations")} rows={3} />}
      {list.status === "ready" && list.value.length > 0 && <section className="t-details-group">
        <h3 className="t-group-name">{t("common.recentInvitations")}</h3>
        <ul className="t-list">
          {list.value.map(({ invitation, revoke }) => <li className="t-list-row" key={invitation.id}>
            <span className="t-stack">
              <strong>{invitation.deliveryEmail ?? t("access.shareableLink")}</strong>
              <small>{invitationStatus(invitation.status).label} · {t("access.createdAt", { time: formatDateTime(invitation.createdAt) })} · {t("access.expiresAt", { time: formatDateTime(invitation.expiresAt) })}{invitation.delivery === "failed" ? t("access.emailFailed2") : ""}</small>
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
    { id: "role", label: t("access.role"), width: "160px", render: (role) => <strong>{role.name}</strong> },
    { id: "description", label: t("access.description"), width: "50%", render: (role) => role.description },
    { id: "permissions", label: t("access.permissions"), render: (role) => <Verb action={model.read(role)} size="small" tone="primary" /> },
    { id: "verbs", label: t("common.actions"), verbs: true, width: "80px", render: (role) => <Overflow groups={[[model.edit(role)], [model.remove(role)]]} label={t("common.actionsMemberName", { memberName: role.name })} menu size="small" /> },
  ];
  const state = model.roles;
  return (
    <Page>
      {state.status === "error" && <LoadError state={state} title={t("access.rolesCouldNotLoaded2")} verb={t("access.readRoles")} />}
      {state.status !== "error" && <Panel flush>
        <FilterRow disabled={state.status !== "ready"} filter={filter} label={t("access.searchRoles")} placeholder={t("access.searchByRoleDescription")}>
          <Verb action={model.create} tone="primary" />
        </FilterRow>
        <Table
          columns={columns}
          empty={filter.active ? <NoMatches filter={filter} noun="roles" /> : <Empty title={t("access.noRoles")} />}
          label={t("access.rolesPermissions")}
          loading={state.status === "loading"}
          rowKey={(role) => role.id}
          rows={filter.rows}
        />
      </Panel>}

      <Panel name={t("access.defaultRole")}>
        <Field label={t("access.givenApproval")}>
          <RoleSelect choice={model.defaultRole.choice} label={t("access.defaultRole")} onChange={model.defaultRole.set} />
        </Field>
      </Panel>

      <ConfirmationDialog model={model.deletion} />
      <RoleEditor model={model.editor} />

      <Drawer
        cancel={model.closeReading}
        cancelLabel={t("common.close")}
        closeActionId={model.closeReading.id}
        description={model.reading ? roleDescription(model.reading) : undefined}
        footer={model.reading && <><Verb action={model.edit(model.reading)} /><Verb action={model.remove(model.reading)} tone="danger" /></>}
        onClose={model.closeReading.run}
        open={model.reading !== null}
        title={model.reading?.name ?? t("access.role")}
      >
        {model.reading && <RolePermissions catalogue={catalogue} key={model.reading.id} role={model.reading} />}
      </Drawer>
    </Page>
  );
}

function roleDescription(role: Role): string {
  const kind = role.builtIn ? t("access.builtInRole") : t("access.customRole");
  return `${kind} · ${t("access.permissionCount", { count: role.permissions.length })} · ${t("access.personCount", { count: role.holders })}`;
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
      title={model?.title ?? t("access.role")}
    >
      {model && (
        <div className="t-form">
          <Field label={t("common.name")}>
            <TextInput data-autofocus {...fields!.name} />
          </Field>
          {model.mode === "create" && (
            <Field error={model.idError} hint={ROLE_ID_HINT} label="ID">
              <TextInput mono {...fields!.id} />
            </Field>
          )}
          <Field label={t("access.description")}>
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
      {permissions.length > SEARCHABLE_PERMISSIONS && <FilterRow filter={filter} label={t("access.searchPermissions")} placeholder={t("access.searchByPermissionDescription")} plain />}
      {filter.rows.length === 0
        ? <NoMatches filter={filter} noun="permissions" />
        : <Details className="t-details-code" items={filter.rows.map((permission) => ({ label: permission.id, value: permission.description ? <><strong>{permission.label}</strong> · {permission.description}</> : <Ghost>{t("access.noDescriptionRecordedPermission")}</Ghost> }))} label={t("access.permissions")} />}
    </div>
  );
}

function Notifications({ model }: Readonly<{ model: NotificationsModel }>) {
  const columns: readonly Col<Game>[] = [
    { id: "game", label: t("common.game"), render: (game) => <strong>{game.displayName}</strong> },
    { id: "started", label: t("access.sessionStarted"), align: "end", width: "170px", render: (game) => <Toggle action={model.toggle(`${game.id}.started`, t("access.gameDisplayNameStarted", { gameDisplayName: game.displayName }))} checked={Boolean(model.subscriptions[`${game.id}.started`])} labelHidden /> },
    { id: "stopped", label: t("access.sessionStopped"), align: "end", width: "170px", render: (game) => <Toggle action={model.toggle(`${game.id}.stopped`, t("access.gameDisplayNameStopped", { gameDisplayName: game.displayName }))} checked={Boolean(model.subscriptions[`${game.id}.stopped`])} labelHidden /> },
  ];
  return (
    <Page>
      {model.state === "error" && <Notice description={model.error} title={t("access.subscriptionsUnavailable")} tone="error" verbs={model.retry ? <Verb action={model.retry} size="small" /> : undefined} />}
      <Panel flush head={<output aria-live="polite" className="t-panel-note">{model.saveStatus}</output>} name={t("access.sessionEvents")}>
        <Table columns={columns} empty={<Empty title={t("access.noGames")} />} label={t("access.sessionEventSubscriptions")} loading={model.state === "loading"} rowKey={(game) => game.id} rows={model.games} />
      </Panel>
      <Panel name={t("access.gameInvitations")}>
        {model.state === "loading" ? <SkeletonRows label={t("access.loadingInvitationPreferences")} rows={2} /> : <div className="t-toggle-list">
          <Toggle action={model.toggle("invitation.broadcast", t("access.invitationsSentEveryone"))} checked={Boolean(model.subscriptions["invitation.broadcast"])} />
          <Toggle action={model.toggle("invitation.direct", t("access.invitationsSentDirectlyMe"))} checked={Boolean(model.subscriptions["invitation.direct"])} />
        </div>}
      </Panel>
      <Panel>
        <div className="t-delivery">
          <strong>{t("access.deliveryChannel")}</strong>
          <State kind="ok" label={t("access.telegramLinked")} />
        </div>
      </Panel>
    </Page>
  );
}
