import { useMemo, useState } from "react";

import type { LinkedLoginAccount } from "../../api/contract";
import { Avatar } from "../../components/Avatar";
import { TelegramLoginButton } from "../../components/TelegramLogin";
import { ActionRow, Button } from "../../components/ui/Button";
import { Chip, ChoiceChip } from "../../components/ui/Chip";
import { TextField } from "../../components/ui/Fields";
import { Skeleton } from "../../components/ui/Skeleton";
import { useSnackbar } from "../../components/ui/Snackbar";
import { Banner, Card, EmptyState, PageHeader } from "../../components/ui/Surfaces";
import type { AppearanceModel, LoginAccountsModel, ProfileModel } from "../../core/models";
import { Icon, type IconName } from "../../icons";
import { PASSWORD_MAXIMUM_LENGTH, PASSWORD_MINIMUM_LENGTH } from "../../lib/signin";
import { deriveAccent, DEFAULT_ACCENT, parseHex } from "../../styles/accent";
import type { ThemePreference } from "../../telegram";
import { ActionButton } from "./actions";

export function Profile({ model }: Readonly<{ model: ProfileModel }>) {
  const { member, role, viewer } = model;
  return (
    <div className="page">
      <PageHeader
        actions={<>
          {model.openInBrowser && <ActionButton action={model.openInBrowser} variant="outlined" />}
          <ActionButton action={model.signOut} variant="text" />
        </>}
        leading={<Avatar name={member.name} photoUrl={viewer.photoUrl} size="large" />}
        status={<Chip icon="admin_panel_settings" tone="primary">{role?.name ?? "No role"}</Chip>}
        subtitle={viewer.username ? `@${viewer.username}` : viewer.email ?? "Spawnpoint identity"}
        title={member.name}
      />
      <Appearance model={model.appearance} />
      <LoginAccounts model={model.loginAccounts} />
    </div>
  );
}

const THEMES: readonly { id: ThemePreference; label: string; icon: IconName }[] = [
  { id: "system", label: "System", icon: "brightness_auto" },
  { id: "light", label: "Light", icon: "light_mode" },
  { id: "dark", label: "Dark", icon: "dark_mode" },
];

/** A starting point, not a limit: the field below takes any colour. */
const SUGGESTED: readonly { name: string; colour: string }[] = [
  { name: "Blue", colour: "#1a73e8" },
  { name: "Green", colour: "#1e8e3e" },
  { name: "Purple", colour: "#8430ce" },
  { name: "Red", colour: "#d93025" },
  { name: "Orange", colour: "#e8710a" },
  { name: "Teal", colour: "#00838f" },
  { name: "Pink", colour: "#c2185b" },
  { name: "Grey", colour: "#5f5f5f" },
];

function Appearance({ model }: Readonly<{ model: AppearanceModel }>) {
  const notify = useSnackbar();
  const [draft, setDraft] = useState(model.accent);
  // What the panel would actually paint, so the note below describes the
  // colour in use rather than the colour that was typed.
  const derived = useMemo(() => deriveAccent(model.accent, model.theme), [model.accent, model.theme]);

  function save(next: { theme?: ThemePreference; accent?: string }) {
    // The panel has already repainted; the setters write through to the account.
    // Storing is what makes the choice follow the person to another device, so
    // only that failure is worth saying, and only here, where there is room.
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
    <Card description="Stored against your identity, so the console looks the same on every device you sign in from." title="Appearance">
      <div className="appearance">
        <div className="appearance-group">
          <span className="appearance-label" id="appearance-theme">Theme</span>
          <fieldset aria-labelledby="appearance-theme" className="chip-row fieldset-plain">
            {THEMES.map((option) => (
              <ChoiceChip icon={option.icon} key={option.id} onClick={() => save({ theme: option.id })} pressed={model.preference === option.id}>{option.label}</ChoiceChip>
            ))}
          </fieldset>
        </div>
        <div className="appearance-group">
          <span className="appearance-label" id="appearance-accent">Accent</span>
          <fieldset aria-labelledby="appearance-accent" className="accent-row fieldset-plain">
            <label className="accent-well">
              <input aria-label="Pick an accent colour" onChange={(event) => commitAccent(event.target.value)} type="color" value={parseHex(draft) ? draft : model.accent} />
            </label>
            <TextField hint={valid ? undefined : "Six hex digits, for example #1a73e8."} label="Hex" mono onChange={(event) => commitAccent(event.target.value)} spellCheck={false} value={draft} />
            <Button disabled={model.accent === DEFAULT_ACCENT} icon="restore" onClick={() => { setDraft(DEFAULT_ACCENT); save({ accent: DEFAULT_ACCENT }); }} variant="text">Reset</Button>
          </fieldset>
          <div className="swatches">
            {SUGGESTED.map(({ name, colour }) => (
              <button aria-label={`${name} ${colour}`} aria-pressed={model.accent === colour} className="swatch" key={colour} onClick={() => { setDraft(colour); save({ accent: colour }); }} style={{ background: colour }} type="button" />
            ))}
          </div>
          {/* A picked colour is a hue, not a contrast ratio. When the two
              disagree the panel keeps the hue and moves the lightness, and
              says so rather than quietly painting something else. */}
          {derived?.adjusted === true && (
            <p className="appearance-note">
              Lightened or darkened for the {model.theme} theme so text on it stays readable. Links and buttons use <code>{derived.ink}</code>.
            </p>
          )}
        </div>
      </div>
    </Card>
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
  const offers = model.connectTelegram !== null || model.addPassword !== null;
  return (
    <Card
      actions={offers ? <ActionRow>
        {model.connectTelegram && <TelegramLoginButton className="telegram-login" label="Add Telegram" onToken={model.connectTelegram} />}
        {model.addPassword && <ActionButton action={model.addPassword} variant="outlined" />}
      </ActionRow> : undefined}
      description="Every method belongs to the same Spawnpoint identity. None becomes primary because it was added first."
      title="Sign-in methods"
    >
      {accounts.status === "loading" && <div aria-label="Loading sign-in methods" className="account-loading"><Skeleton height={56} /><Skeleton height={56} /></div>}
      {accounts.status === "error" && <Banner actions={<ActionButton action={accounts.retry} size="small" variant="outlined" />} description={accounts.error} title="Sign-in methods are unavailable" tone="error" />}
      {accounts.status === "ready" && accounts.value.length === 0 && <EmptyState description="This identity has no linked login method the current API can report." icon="link" title="No sign-in methods" />}
      {accounts.status === "ready" && accounts.value.length > 0 && (
        <ul className="login-account-list">
          {accounts.value.map((account) => {
            const presentation = presentProvider(account.provider);
            const rowActions = model.rowActions(account);
            return (
              <li className="login-account-row" key={`${account.provider}:${account.subject}`}>
                <span aria-hidden="true" className="link-icon"><Icon name={presentation.icon} size={20} /></span>
                <span className="login-account-copy">
                  <strong>{presentation.label}</strong>
                  <span>{accountLine(account)}</span>
                </span>
                <Chip icon={account.verified ? "verified" : "pending"} tone={account.verified ? "success" : "warning"}>{account.verified ? "Verified" : "Pending"}</Chip>
                {rowActions.length > 0 && <div className="login-account-actions">{rowActions.map((rowAction) => <ActionButton action={rowAction} key={rowAction.id} size="small" variant="text" />)}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {model.form && (
        <form className="account-form" onSubmit={(event) => { event.preventDefault(); model.form?.submit.run(); }}>
          <h3>{model.form.kind === "add" ? "Add email and password" : "Change password"}</h3>
          <TextField autoComplete="email" disabled={model.form.kind === "change" || model.form.busy} inputMode="email" label="Email" onChange={(event) => model.form?.setEmail(event.target.value)} required type="email" value={model.form.email} />
          {model.form.kind === "change" && <TextField autoComplete="current-password" disabled={model.form.busy} label="Current password" maxLength={PASSWORD_MAXIMUM_LENGTH} onChange={(event) => model.form?.setCurrentPassword(event.target.value)} required type="password" value={model.form.currentPassword} />}
          <TextField autoComplete="new-password" disabled={model.form.busy} hint={`At least ${PASSWORD_MINIMUM_LENGTH} characters.`} label={model.form.kind === "add" ? "Password" : "New password"} maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => model.form?.setPassword(event.target.value)} required type="password" value={model.form.password} />
          <TextField autoComplete="new-password" disabled={model.form.busy} label="Confirm password" maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => model.form?.setConfirmation(event.target.value)} required type="password" value={model.form.confirmation} />
          {model.form.error && <p className="boot-error" role="alert">{model.form.error}</p>}
          <div className="btn-row">
            <ActionButton action={model.form.cancel} variant="text" />
            <ActionButton action={model.form.submit} type="submit" variant="filled" />
          </div>
        </form>
      )}
    </Card>
  );
}
