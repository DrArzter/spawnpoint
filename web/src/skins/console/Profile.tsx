import type { ReactNode } from "react";

import type { LinkedLoginAccount } from "../../api/contract";
import { GoogleLoginButton } from "../../components/GoogleLogin";
import { TelegramLoginButton } from "../../components/TelegramLogin";
import type { Action } from "../../core/actions";
import type { AppearanceModel, LoginAccountsModel, LookModel, ProfileModel } from "../../core/models";
import { Icon, type IconName } from "../../icons";
import { PASSWORD_MAXIMUM_LENGTH, PASSWORD_MINIMUM_LENGTH } from "../../lib/signin";
import type { ThemePreference } from "../../telegram";
import { ActionButton } from "./ui/ActionButton";
import { Avatar } from "./ui/Avatar";
import { Card } from "./ui/Card";
import { Chip } from "./ui/Chip";
import { Copy } from "./ui/Copy";
import { LoadError } from "./ui/Empty";
import { Field, RadioCards, TextInput } from "./ui/Fields";
import { Grid } from "./ui/Grid";
import { Indicator } from "./ui/Indicator";
import { Notice } from "./ui/Notice";
import { Overflow } from "./ui/Overflow";
import { PageHeader } from "./ui/PageHeader";
import { SidePanel } from "./ui/SidePanel";
import { SkeletonRows } from "./ui/Skeleton";
import { useToast } from "./ui/Toast";
import { TrackList, TrackTitle, type Track } from "./ui/TrackList";

// Profile (spec §6.6): the name at the start, the role last at the end edge (on a phone too); the skin's only theme control.
export function Profile({ model }: Readonly<{ model: ProfileModel }>) {
  const { member, role, viewer } = model;
  return (
    <div className="c-page">
      <PageHeader
        actions={<>
          {model.openInBrowser && <ActionButton action={model.openInBrowser} />}
          <ActionButton action={model.signOut} />
          {role && <Chip icon="shield_person">{role.name}</Chip>}
        </>}
        after={(
          <span className="c-profile-id">
            <span className="c-mono c-faint" data-tip="Identity ID" tabIndex={0}>{member.id}</span>
            <Copy value={member.id} what="identity ID" />
          </span>
        )}
        lead={<Avatar name={member.name} photoUrl={viewer.photoUrl} size="xl" />}
        title={member.name}
      />
      <Grid kind="profile">
        <SignInMethods model={model.loginAccounts} />
        <Appearance look={model.look} model={model.appearance} />
      </Grid>
      {model.loginAccounts.form && <PasswordPanel form={model.loginAccounts.form} />}
    </div>
  );
}

const THEMES: readonly { value: ThemePreference; label: string; icon: IconName }[] = [
  { value: "light", label: "Light", icon: "light_mode" },
  { value: "dark", label: "Dark", icon: "dark_mode" },
  { value: "system", label: "System", icon: "contrast" },
];

function Appearance({ model, look }: Readonly<{ model: AppearanceModel; look: LookModel }>) {
  const toast = useToast();
  const choose = (next: ThemePreference) => {
    model.setPreference(next).catch((error: unknown) => toast(error instanceof Error ? error.message : "The theme could not be saved.", "err"));
  };
  return (
    <Card title="Appearance">
      <div className="c-profile-settings">
        <RadioCards legend="Theme" name="theme" onChange={choose} options={THEMES} value={model.preference} />
        {look.options.length > 0 && (
          <RadioCards
            legend="Look"
            name="look"
            onChange={() => undefined}
            options={look.options.map((option) => ({ value: option.id, label: option.name, action: option.choose }))}
            value={look.current}
          />
        )}
      </div>
    </Card>
  );
}

const providers: Readonly<Record<string, { label: string; icon: IconName }>> = {
  password: { label: "Email", icon: "mail" },
  telegram: { label: "Telegram", icon: "send" },
  google: { label: "Google", icon: "account_circle" },
  discord: { label: "Discord", icon: "group" },
};

function provider(id: string): { label: string; icon: IconName } {
  return providers[id] ?? { label: id.replaceAll(/[-_]/g, " ").replace(/^./, (letter) => letter.toUpperCase()), icon: "link" };
}

type MethodRow = Readonly<{
  key: string;
  provider: string;
  account: LinkedLoginAccount | null;
  actions: readonly Action[];
  /** The provider's own sign-in widget, for a method not linked yet. */
  widget?: ReactNode;
}>;

// Linked methods first, then each method the person can still add.
function methodRows(model: LoginAccountsModel, accounts: readonly LinkedLoginAccount[]): MethodRow[] {
  const rows: MethodRow[] = accounts.map((account) => ({
    key: `${account.provider}:${account.subject}`,
    provider: account.provider,
    account,
    actions: [...model.rowActions(account), ...(account.provider === "password" && model.addPassword ? [model.addPassword] : [])],
  }));
  const linked = new Set(accounts.map((account) => account.provider));
  if (!linked.has("password") && model.addPassword) rows.push({ key: "password", provider: "password", account: null, actions: [model.addPassword] });
  for (const id of model.linkable) {
    if (linked.has(id)) continue;
    const widget = id === "telegram" && model.connectTelegram
      ? <TelegramLoginButton label="Link" onToken={model.connectTelegram} variant="outlined" />
      : id === "google" && model.connectGoogle ? <GoogleLoginButton onToken={model.connectGoogle} /> : undefined;
    rows.push({ key: id, provider: id, account: null, actions: [], widget });
  }
  return rows;
}

function accountText(account: LinkedLoginAccount | null): ReactNode {
  if (!account) return <span className="c-faint">Not linked</span>;
  const text = account.email ?? (account.username ? `@${account.username}` : account.displayName ?? "");
  return (
    <span className="c-profile-account">
      <span className="c-profile-account-text" title={text}>{text}</span>
      {!account.verified && <Indicator status={{ kind: "pending", label: "Pending verification" }} />}
    </span>
  );
}

function RowActions({ row }: Readonly<{ row: MethodRow }>) {
  const [first, ...rest] = row.actions;
  return (
    <span className="c-profile-row-actions">
      {row.widget}
      {first && <ActionButton action={first} size="sm" />}
      {rest.length > 0 && <Overflow actions={rest} label={`More for ${provider(row.provider).label}`} size="sm" />}
    </span>
  );
}

const tracks: readonly Track<MethodRow>[] = [
  {
    id: "method",
    header: "Method",
    width: "minmax(140px, auto)",
    compactWidth: "minmax(0, 1fr)",
    kind: "stack",
    render: (row) => {
      const look = provider(row.provider);
      return <TrackTitle compactLine={accountText(row.account)} title={<span className="c-profile-method"><Icon name={look.icon} size={18} />{look.label}</span>} />;
    },
  },
  { id: "account", header: "Account", width: "minmax(0, 1fr)", kind: "optional", render: (row) => accountText(row.account) },
  { id: "action", header: "Action", width: "auto", kind: "end", quietHeader: true, render: (row) => <RowActions row={row} /> },
];

function SignInMethods({ model }: Readonly<{ model: LoginAccountsModel }>) {
  const accounts = model.accounts;
  return (
    <Card body="flush" title="Sign-in methods">
      {accounts.status === "loading" && <SkeletonRows columns={3} rows={3} />}
      {accounts.status === "error" && <LoadError error={accounts.error} kind={accounts.kind} retry={accounts.retry} title="Sign-in methods could not be loaded" verb="read sign-in methods" />}
      {accounts.status === "ready" && <TrackList label="Sign-in methods" rowKey={(row) => row.key} rows={methodRows(model, accounts.value)} tracks={tracks} />}
    </Card>
  );
}

function PasswordPanel({ form }: Readonly<{ form: NonNullable<LoginAccountsModel["form"]> }>) {
  const length = `${PASSWORD_MINIMUM_LENGTH} to ${PASSWORD_MAXIMUM_LENGTH} characters`;
  return (
    <SidePanel actions={<ActionButton action={form.submit} variant="primary" />} cancel={form.cancel} title={form.kind === "add" ? "Add email and password" : "Change password"}>
      {form.kind === "add" && (
        <Field label="Email">
          <TextInput autoComplete="email" disabled={form.busy} inputMode="email" onChange={(event) => form.setEmail(event.target.value)} required type="email" value={form.email} />
        </Field>
      )}
      {form.kind === "change" && (
        <Field label="Current password">
          <TextInput autoComplete="current-password" disabled={form.busy} maxLength={PASSWORD_MAXIMUM_LENGTH} onChange={(event) => form.setCurrentPassword(event.target.value)} required type="password" value={form.currentPassword} />
        </Field>
      )}
      <Field label="New password">
        <TextInput autoComplete="new-password" data-tip={length} disabled={form.busy} maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => form.setPassword(event.target.value)} required type="password" value={form.password} />
      </Field>
      <Field label="Confirm password">
        <TextInput autoComplete="new-password" disabled={form.busy} maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => form.setConfirmation(event.target.value)} required type="password" value={form.confirmation} />
      </Field>
      {form.error && <Notice notice={{ id: "password-error", tone: "error", title: form.error }} />}
    </SidePanel>
  );
}
