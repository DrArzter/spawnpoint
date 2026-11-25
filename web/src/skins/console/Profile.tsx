import type { ReactNode } from "react";

import type { LinkedLoginAccount } from "../../api/contract";
import { GoogleLoginButton } from "../../components/GoogleLogin";
import { TelegramLoginButton } from "../../components/TelegramLogin";
import { action, type Action } from "../../core/actions";
import type { AppearanceModel, AvatarModel, LoginAccountsModel, LookModel, ProfileModel } from "../../core/models";
import { Icon, type IconName } from "../../icons";
import { PASSWORD_MAXIMUM_LENGTH, PASSWORD_MINIMUM_LENGTH } from "../../lib/signin";
import { DEFAULT_ACCENT, parseHex } from "../../styles/accent";
import type { ThemePreference } from "../../telegram";
import { IRIS } from "./ui/accent";
import { ActionButton } from "./ui/ActionButton";
import { Card } from "./ui/Card";
import { Chip } from "./ui/Chip";
import { Copy } from "./ui/Copy";
import { LoadError } from "./ui/Empty";
import { ColourInput, Field, RadioCards, TextInput } from "./ui/Fields";
import { Grid } from "./ui/Grid";
import { Indicator } from "./ui/Indicator";
import { Notice } from "./ui/Notice";
import { Overflow } from "./ui/Overflow";
import { PageHeader } from "./ui/PageHeader";
import { SidePanel } from "./ui/SidePanel";
import { useToast } from "./ui/Toast";
import { TrackList, TrackTitle, type Track } from "./ui/TrackList";
import { t } from "../../i18n";

// Profile: the name, its role and its id at the start, the verbs at the end edge; the skin's only theme control.
export function Profile({ model }: Readonly<{ model: ProfileModel }>) {
  const { member, role, viewer } = model;
  return (
    <div className="c-page">
      <PageHeader
        actions={<>
          {model.openInBrowser && <ActionButton action={model.openInBrowser} />}
          <ActionButton action={model.signOut} />
        </>}
        after={(
          <>
          {role && <Chip icon="shield_person">{role.name}</Chip>}
          <span className="c-profile-id">
            <span className="c-mono c-faint" data-tip={t("profile.identityID")} tabIndex={0 /* NOSONAR focusable tooltip trigger */}>{member.id}</span>
            <Copy value={member.id} what={t("profile.identityID2")} />
          </span>
          </>
        )}
        lead={<Overflow actions={avatarActions(model.avatar)} avatar={{ name: member.name, photoUrl: viewer.photoUrl, size: "lg" }} label={t("profile.changePicture")} />}
        title={member.name}
      />
      <Grid kind="profile">
        <SignInMethods model={model.loginAccounts} />
        <Appearance language={model.language} look={model.look} model={model.appearance} />
      </Grid>
      {model.loginAccounts.form && <PasswordPanel form={model.loginAccounts.form} />}
    </div>
  );
}

function avatarActions(model: AvatarModel): readonly Action[] {
  return model.remove ? [model.change, model.remove] : [model.change];
}

const THEMES: readonly { value: ThemePreference; label: string; icon: IconName }[] = [
  { value: "light", label: t("profile.light"), icon: "light_mode" },
  { value: "dark", label: t("profile.dark"), icon: "dark_mode" },
  { value: "system", label: t("profile.system"), icon: "contrast" },
];

function Appearance({ model, look, language }: Readonly<{ model: AppearanceModel; look: LookModel; language: LookModel }>) {
  const toast = useToast();
  const choose = (next: ThemePreference) => {
    model.setPreference(next).catch((error: unknown) => toast(error instanceof Error ? error.message : t("profile.themeCouldNotSaved"), "err"));
  };
  // The iris is the face's own accent; a colour picked here overrides it until Reset.
  const pick = (next: string) => {
    if (parseHex(next) === null) return;
    model.setAccent(next.trim().toLowerCase()).catch((error: unknown) => toast(error instanceof Error ? error.message : t("profile.accentCouldNotSaved"), "err"));
  };
  const chosen = model.accent.toLowerCase() !== DEFAULT_ACCENT;
  // Without a pick the well shows what the console draws: its own iris.
  const shown = chosen && parseHex(model.accent) ? model.accent : IRIS;
  const reset = action("appearance.accent.reset", t("profile.reset"), () => pick(DEFAULT_ACCENT), { icon: "restore", disabled: !chosen, hint: chosen ? undefined : t("profile.defaultAccentUse") });
  return (
    <Card title={t("profile.appearance")}>
      <div className="c-profile-settings">
        <RadioCards legend={t("profile.theme")} name="theme" onChange={choose} options={THEMES} value={model.preference} />
        {look.options.length > 0 && (
          <RadioCards
            legend={t("profile.look")}
            name="look"
            onChange={() => undefined}
            options={look.options.map((option) => ({ value: option.id, label: option.name, action: option.choose }))}
            value={look.current}
          />
        )}
        <RadioCards
          legend={t("profile.language")}
          name="language"
          onChange={() => undefined}
          options={language.options.map((option) => ({ value: option.id, label: option.name, action: option.choose }))}
          value={language.current}
        />
        <Field label={t("profile.accent")}>
          <span className="c-profile-accent">
            <ColourInput onChange={(event) => pick(event.target.value)} value={shown} />
            <ActionButton action={reset} size="sm" />
          </span>
        </Field>
      </div>
    </Card>
  );
}

const providers: Readonly<Record<string, { label: string; icon: IconName }>> = {
  password: { label: t("common.email"), icon: "mail" },
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

/** The provider's own sign-in widget for a method not linked yet; none for a provider without one. */
function linkWidget(id: string, model: LoginAccountsModel): ReactNode {
  if (id === "telegram" && model.connectTelegram) return <TelegramLoginButton label={t("profile.link")} onToken={model.connectTelegram} variant="outlined" />;
  if (id === "google" && model.connectGoogle) return <GoogleLoginButton onToken={model.connectGoogle} />;
  return undefined;
}

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
    rows.push({ key: id, provider: id, account: null, actions: [], widget: linkWidget(id, model) });
  }
  return rows;
}

function accountText(account: LinkedLoginAccount | null): ReactNode {
  if (!account) return <span className="c-faint">{t("profile.notLinked")}</span>;
  const text = account.email ?? (account.username ? `@${account.username}` : account.displayName ?? "");
  return (
    <span className="c-profile-account">
      <span className="c-profile-account-text" title={text}>{text}</span>
      {!account.verified && <Indicator status={{ kind: "pending", label: t("common.pendingVerification") }} />}
    </span>
  );
}

function RowActions({ row }: Readonly<{ row: MethodRow }>) {
  const [first, ...rest] = row.actions;
  return (
    <span className="c-profile-row-actions">
      {row.widget}
      {first && <ActionButton action={first} size="sm" />}
      {rest.length > 0 && <Overflow actions={rest} label={t("common.moreLabel", { label: provider(row.provider).label })} size="sm" />}
    </span>
  );
}

const tracks: readonly Track<MethodRow>[] = [
  {
    id: "method",
    header: t("profile.method"),
    width: "minmax(140px, auto)",
    compactWidth: "minmax(0, 1fr)",
    kind: "stack",
    lines: 1,
    render: (row) => {
      const look = provider(row.provider);
      return <TrackTitle compactLine={accountText(row.account)} title={<span className="c-profile-method"><Icon name={look.icon} size={18} />{look.label}</span>} />;
    },
  },
  { id: "account", header: t("common.account"), width: "minmax(0, 1fr)", kind: "optional", render: (row) => accountText(row.account) },
  { id: "action", header: t("common.action"), width: "auto", kind: "end", quietHeader: true, render: (row) => <RowActions row={row} /> },
];

function SignInMethods({ model }: Readonly<{ model: LoginAccountsModel }>) {
  const accounts = model.accounts;
  return (
    <Card body="flush" title={t("profile.signInMethods")}>
      {accounts.status === "error" && <LoadError error={accounts.error} kind={accounts.kind} retry={accounts.retry} title={t("profile.signInMethodsCouldNot")} verb={t("profile.readSignInMethods")} />}
      {accounts.status !== "error" && <TrackList label={t("profile.signInMethods")} loading={accounts.status === "loading"} rowKey={(row) => row.key} rows={accounts.status === "ready" ? methodRows(model, accounts.value) : []} tracks={tracks} />}
    </Card>
  );
}

function PasswordPanel({ form }: Readonly<{ form: NonNullable<LoginAccountsModel["form"]> }>) {
  const length = t("profile.pASSWORDMINIMUMLENGTHPASSWORD", { PASSWORD_MINIMUM_LENGTH, PASSWORD_MAXIMUM_LENGTH });
  return (
    <SidePanel actions={<ActionButton action={form.submit} variant="primary" />} cancel={form.cancel} title={form.kind === "add" ? t("profile.addEmailPassword") : t("common.changePassword")}>
      {form.kind === "add" && (
        <Field label={t("common.email")}>
          <TextInput autoComplete="email" disabled={form.busy} inputMode="email" onChange={(event) => form.setEmail(event.target.value)} required type="email" value={form.email} />
        </Field>
      )}
      {form.kind === "change" && (
        <Field label={t("profile.currentPassword")}>
          <TextInput autoComplete="current-password" disabled={form.busy} maxLength={PASSWORD_MAXIMUM_LENGTH} onChange={(event) => form.setCurrentPassword(event.target.value)} required type="password" value={form.currentPassword} />
        </Field>
      )}
      <Field label={t("common.newPassword")}>
        <TextInput autoComplete="new-password" data-tip={length} disabled={form.busy} maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => form.setPassword(event.target.value)} required type="password" value={form.password} />
      </Field>
      <Field label={t("profile.confirmPassword")}>
        <TextInput autoComplete="new-password" disabled={form.busy} maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => form.setConfirmation(event.target.value)} required type="password" value={form.confirmation} />
      </Field>
      {form.error && <Notice notice={{ id: "password-error", tone: "error", title: form.error }} />}
    </SidePanel>
  );
}
