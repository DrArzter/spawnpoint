import { useState } from "react";

import type { LinkedLoginAccount } from "../../api/contract";
import { GoogleLoginButton } from "../../components/GoogleLogin";
import { TelegramLoginButton } from "../../components/TelegramLogin";
import { useSnackbar } from "../../components/ui/Snackbar";
import type { AppearanceModel, LoginAccountsModel, LookModel, ProfileModel } from "../../core/models";
import { Icon, type IconName } from "../../icons";
import { PASSWORD_MAXIMUM_LENGTH, PASSWORD_MINIMUM_LENGTH } from "../../lib/signin";
import { DEFAULT_ACCENT, parseHex } from "../../styles/accent";
import type { ThemePreference } from "../../telegram";
import { Avatar, Choice, Choices, Empty, Field, Indicator, Key, Notice, Overflow, Page, Panel, SkeletonRows, TextInput, Verb, Verbs } from "./ui";

export function Profile({ model }: Readonly<{ model: ProfileModel }>) {
  const { member, role, viewer } = model;
  return (
    <Page>
      <header className="t-page-head">
        <div className="t-page-title t-page-title-person">
          <Avatar name={member.name} photoUrl={viewer.photoUrl} size="large" />
          <div className="t-stack">
            <h1>{member.name}</h1>
            <small>{viewer.username ? `@${viewer.username}` : viewer.email ?? "Spawnpoint identity"}</small>
          </div>
          <span className="t-tag t-tag-primary">{role?.name ?? "No role"}</span>
        </div>
        <Verbs className="t-page-verbs">
          {model.openInBrowser && <Verb action={model.openInBrowser} />}
          <Verb action={model.signOut} />
        </Verbs>
      </header>
      <Appearance look={model.look} model={model.appearance} />
      <LoginAccounts model={model.loginAccounts} />
    </Page>
  );
}

const THEMES: readonly { id: ThemePreference; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function Appearance({ model, look }: Readonly<{ model: AppearanceModel; look: LookModel }>) {
  const notify = useSnackbar();
  const [draft, setDraft] = useState(model.accent);

  function save(next: { theme?: ThemePreference; accent?: string }) {
    const writes: Promise<void>[] = [];
    if (next.theme) writes.push(model.setPreference(next.theme));
    if (next.accent) writes.push(model.setAccent(next.accent));
    Promise.all(writes).catch((error: unknown) => {
      notify({ tone: "error", message: error instanceof Error ? error.message : "The appearance could not be saved to your profile." });
    });
  }

  function commitAccent(value: string) {
    setDraft(value);
    if (parseHex(value) !== null) save({ accent: value.trim().toLowerCase() });
  }

  const valid = parseHex(draft) !== null;
  return (
    <Panel name="Appearance">
      <div className="t-settings">
        <div className="t-setting">
          <span className="t-setting-label" id="t-appearance-theme">Theme</span>
          <Choices label="Theme">
            {THEMES.map((option) => <Choice key={option.id} onClick={() => save({ theme: option.id })} pressed={model.preference === option.id}>{option.label}</Choice>)}
          </Choices>
        </div>
        <div className="t-setting">
          <span className="t-setting-label">Look</span>
          <Choices label="Look">
            {look.options.map((option) => <Choice data-action={option.choose.id} key={option.id} onClick={option.choose.run} pressed={option.id === look.current} title={option.choose.hint}>{option.name}</Choice>)}
          </Choices>
        </div>
        <div className="t-setting">
          <span className="t-setting-label">Accent</span>
          <div className="t-accent-row">
            <label className="t-accent-well">
              <input aria-label="Pick an accent colour" onChange={(event) => commitAccent(event.target.value)} type="color" value={parseHex(draft) ? draft : model.accent} />
            </label>
            <Field hideLabel hint={valid ? undefined : "Six hex digits, for example #1a73e8."} label="Accent colour, hex">
              <TextInput mono onChange={(event) => commitAccent(event.target.value)} spellCheck={false} value={draft} />
            </Field>
            <Key disabled={model.accent === DEFAULT_ACCENT} label="Reset" onClick={() => { setDraft(DEFAULT_ACCENT); save({ accent: DEFAULT_ACCENT }); }} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

const providerPresentation: Readonly<Record<string, { label: string; icon: IconName }>> = {
  password: { label: "Email and password", icon: "mail" },
  telegram: { label: "Telegram", icon: "send" },
  google: { label: "Google", icon: "account_circle" },
  discord: { label: "Discord", icon: "group" },
};

function presentProvider(provider: string): { label: string; icon: IconName } {
  return providerPresentation[provider] ?? { label: provider.replaceAll(/[-_]/g, " ").replace(/^./, (letter) => letter.toUpperCase()), icon: "link" };
}

function accountLine(account: LinkedLoginAccount): string {
  return account.email ?? (account.username ? `@${account.username}` : account.displayName ?? account.subject);
}

function LoginAccounts({ model }: Readonly<{ model: LoginAccountsModel }>) {
  const accounts = model.accounts;
  const offers = model.connectTelegram !== null || model.connectGoogle !== null || model.addPassword !== null;
  return (
    <Panel name="Sign-in methods">
      {accounts.status === "loading" && <SkeletonRows label="Loading sign-in methods" rows={2} />}
      {accounts.status === "error" && <Notice description={accounts.error} title="Sign-in methods are unavailable" tone="error" verbs={<Verb action={accounts.retry} size="small" />} />}
      {accounts.status === "ready" && accounts.value.length === 0 && <Empty title="No sign-in methods" />}
      {accounts.status === "ready" && accounts.value.length > 0 && (
        <ul className="t-list">
          {accounts.value.map((account) => {
            const presentation = presentProvider(account.provider);
            const rowActions = model.rowActions(account);
            return (
              <li className="t-list-row t-login-row" key={`${account.provider}:${account.subject}`}>
                <span aria-hidden="true" className="t-list-icon"><Icon name={presentation.icon} size={18} /></span>
                <span className="t-stack">
                  <span className="t-account-provider">
                    <strong>{presentation.label}</strong>
                    <Indicator kind={account.verified ? "ok" : "pending"} label={account.verified ? "Verified" : "Pending verification"} />
                  </span>
                  <span>{accountLine(account)}</span>
                </span>
                {rowActions.length > 0 && <Overflow groups={[rowActions]} label={`Manage ${presentation.label}`} size="small" />}
              </li>
            );
          })}
        </ul>
      )}
      {offers && (
        <Verbs>
          {/* The two provider widgets are the providers' own flows; they keep
              their own look, as a sign-in button from elsewhere should. */}
          {model.connectTelegram && <TelegramLoginButton className="t-provider" label="Add Telegram" onToken={model.connectTelegram} variant="outlined" />}
          {model.connectGoogle && <GoogleLoginButton className="t-provider" onToken={model.connectGoogle} />}
          {model.addPassword && <Verb action={model.addPassword} />}
        </Verbs>
      )}
      {model.form && (
        <form className="t-form" onSubmit={(event) => { event.preventDefault(); model.form?.submit.run(); }}>
          <h3 className="t-group-name">{model.form.kind === "add" ? "Add email and password" : "Change password"}</h3>
          <Field label="Email"><TextInput autoComplete="email" disabled={model.form.kind === "change" || model.form.busy} inputMode="email" onChange={(event) => model.form?.setEmail(event.target.value)} required type="email" value={model.form.email} /></Field>
          {model.form.kind === "change" && <Field label="Current password"><TextInput autoComplete="current-password" disabled={model.form.busy} maxLength={PASSWORD_MAXIMUM_LENGTH} onChange={(event) => model.form?.setCurrentPassword(event.target.value)} required type="password" value={model.form.currentPassword} /></Field>}
          <Field hint={`At least ${PASSWORD_MINIMUM_LENGTH} characters.`} label={model.form.kind === "add" ? "Password" : "New password"}><TextInput autoComplete="new-password" disabled={model.form.busy} maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => model.form?.setPassword(event.target.value)} required type="password" value={model.form.password} /></Field>
          <Field label="Confirm password"><TextInput autoComplete="new-password" disabled={model.form.busy} maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => model.form?.setConfirmation(event.target.value)} required type="password" value={model.form.confirmation} /></Field>
          {model.form.error && <p className="t-error" role="alert">{model.form.error}</p>}
          <Verbs>
            <Verb action={model.form.submit} tone="primary" type="submit" />
            <Verb action={model.form.cancel} />
          </Verbs>
        </form>
      )}
    </Panel>
  );
}
