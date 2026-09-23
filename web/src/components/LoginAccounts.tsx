import { useEffect, useState, type FormEvent } from "react";

import {
  changePassword,
  googleOidcClientId,
  linkGoogle,
  linkTelegram,
  linkPassword,
  loadLinkedAccounts,
  resendEmailVerification,
  requestPasswordReset,
  type LinkedLoginAccount,
} from "../auth";
import { Icon, type IconName } from "../icons";
import { PASSWORD_MAXIMUM_LENGTH, PASSWORD_MINIMUM_LENGTH } from "../lib/signin";
import { ActionRow, Button } from "./ui/Button";
import { Chip } from "./ui/Chip";
import { TextField } from "./ui/Fields";
import { useSnackbar } from "./ui/Snackbar";
import { Skeleton } from "./ui/Skeleton";
import { Banner, Card, EmptyState } from "./ui/Surfaces";
import { GOOGLE_CLIENT_ID, GoogleLoginButton } from "./GoogleLogin";
import { TelegramLoginButton } from "./TelegramLogin";

type AccountState =
  | Readonly<{ status: "loading"; accounts: readonly LinkedLoginAccount[]; linkableProviders: readonly string[]; passwordManagementAvailable: false }>
  | Readonly<{ status: "ready"; accounts: readonly LinkedLoginAccount[]; linkableProviders: readonly string[]; passwordManagementAvailable: boolean }>
  | Readonly<{ status: "error"; accounts: readonly LinkedLoginAccount[]; linkableProviders: readonly string[]; passwordManagementAvailable: false; message: string }>;

const providerPresentation: Readonly<Record<string, { label: string; icon: IconName }>> = {
  password: { label: "Email and password", icon: "mail" },
  telegram: { label: "Telegram", icon: "send" },
  google: { label: "Google", icon: "account_circle" },
  discord: { label: "Discord", icon: "group" },
};

function presentProvider(provider: string): { label: string; icon: IconName } {
  return providerPresentation[provider] ?? {
    label: provider.replaceAll(/[-_]/g, " ").replace(/^./, (letter) => letter.toUpperCase()),
    icon: "link",
  };
}

export function LoginAccounts({ displayName }: Readonly<{ displayName: string }>) {
  const notify = useSnackbar();
  const [state, setState] = useState<AccountState>({ status: "loading", accounts: [], linkableProviders: [], passwordManagementAvailable: false });
  const [form, setForm] = useState<"add" | "change" | null>(null);
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      const result = await loadLinkedAccounts();
      setState({ status: "ready", ...result });
    } catch (cause) {
      setState({
        status: "error",
        accounts: [],
        linkableProviders: [],
        passwordManagementAvailable: false,
        message: cause instanceof Error ? cause.message : "Linked sign-in methods could not be loaded.",
      });
    }
  }

  useEffect(() => { void refresh(); }, []);

  const passwordAccount = state.accounts.find((account) => account.provider === "password");
  const telegramAccount = state.accounts.find((account) => account.provider === "telegram");
  const googleAccount = state.accounts.find((account) => account.provider === "google");
  const canLinkTelegram = state.status === "ready" && telegramAccount === undefined && state.linkableProviders.includes("telegram");
  const canLinkGoogle = state.status === "ready" && googleAccount === undefined && state.linkableProviders.includes("google") && GOOGLE_CLIENT_ID.test(googleOidcClientId);
  const canLinkPassword = state.status === "ready" && passwordAccount === undefined && state.passwordManagementAvailable;

  async function connectTelegram(idToken: string) {
    await linkTelegram(idToken);
    notify({ tone: "success", message: "Telegram is now a sign-in method for this identity." });
    await refresh();
  }

  async function connectGoogle(idToken: string) {
    await linkGoogle(idToken);
    notify({ tone: "success", message: "Google is now a sign-in method for this identity." });
    await refresh();
  }

  function openForm(next: "add" | "change", account?: LinkedLoginAccount) {
    setForm(next);
    setEmail(account?.email ?? "");
    setCurrentPassword("");
    setPassword("");
    setConfirmation("");
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      if (form === "add") {
        await linkPassword(email, password, displayName);
        notify({ tone: "success", message: `A verification link was sent to ${email}.` });
      } else {
        await changePassword(email, currentPassword, password);
        notify({ tone: "success", message: "Password changed. Existing password sessions were signed out." });
      }
      setForm(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sign-in method could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function sendRecovery(kind: "verify" | "reset", account: LinkedLoginAccount) {
    if (!account.email) return;
    setBusy(true);
    try {
      if (kind === "verify") await resendEmailVerification(account.email);
      else await requestPasswordReset(account.email);
      notify({
        tone: "success",
        message: kind === "verify" ? `A new verification link was sent to ${account.email}.` : `If the account is eligible, a reset link is on its way to ${account.email}.`,
      });
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "The email could not be sent." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      actions={(canLinkTelegram || canLinkGoogle || canLinkPassword) ? <ActionRow>
        {canLinkTelegram && <TelegramLoginButton className="telegram-login" label="Add Telegram" onToken={connectTelegram} />}
        {canLinkGoogle && <GoogleLoginButton className="google-login" onToken={connectGoogle} />}
        {canLinkPassword && <Button icon="add" onClick={() => openForm("add")} variant="outlined">Add email and password</Button>}
      </ActionRow> : undefined}
      description="Every method belongs to the same Spawnpoint identity. None becomes primary because it was added first."
      title="Sign-in methods"
    >
      {state.status === "loading" && <div aria-label="Loading sign-in methods" className="account-loading"><Skeleton height={56} /><Skeleton height={56} /></div>}
      {state.status === "error" && <Banner actions={<Button onClick={() => void refresh()} size="small" variant="outlined">Retry</Button>} description={state.message} title="Sign-in methods are unavailable" tone="error" />}
      {state.status === "ready" && state.accounts.length === 0 && (
        <EmptyState description="This identity has no linked login method the current API can report." icon="link" title="No sign-in methods" />
      )}
      {state.accounts.length > 0 && (
        <ul className="login-account-list">
          {state.accounts.map((account) => {
            const presentation = presentProvider(account.provider);
            return (
              <li className="login-account-row" key={`${account.provider}:${account.subject}`}>
                <span aria-hidden="true" className="link-icon"><Icon name={presentation.icon} size={20} /></span>
                <span className="login-account-copy">
                  <strong>{presentation.label}</strong>
                  <span>{account.email ?? (account.username ? `@${account.username}` : account.displayName ?? account.subject)}</span>
                </span>
                <Chip icon={account.verified ? "verified" : "pending"} tone={account.verified ? "success" : "warning"}>
                  {account.verified ? "Verified" : "Pending"}
                </Chip>
                {account.provider === "password" && account.email && (
                  <div className="login-account-actions">
                    {account.verified
                      ? <>
                          <Button disabled={busy} onClick={() => openForm("change", account)} size="small" variant="text">Change password</Button>
                          <Button disabled={busy} onClick={() => void sendRecovery("reset", account)} size="small" variant="text">Send reset link</Button>
                        </>
                      : <Button disabled={busy} onClick={() => void sendRecovery("verify", account)} size="small" variant="text">Resend verification</Button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {form !== null && (
        <form className="account-form" onSubmit={(event) => void submit(event)}>
          <h3>{form === "add" ? "Add email and password" : "Change password"}</h3>
          <TextField autoComplete="email" disabled={form === "change" || busy} inputMode="email" label="Email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
          {form === "change" && <TextField autoComplete="current-password" disabled={busy} label="Current password" maxLength={PASSWORD_MAXIMUM_LENGTH} onChange={(event) => setCurrentPassword(event.target.value)} required type="password" value={currentPassword} />}
          <TextField autoComplete="new-password" disabled={busy} hint={`At least ${PASSWORD_MINIMUM_LENGTH} characters.`} label={form === "add" ? "Password" : "New password"} maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
          <TextField autoComplete="new-password" disabled={busy} label="Confirm password" maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => setConfirmation(event.target.value)} required type="password" value={confirmation} />
          {error && <p className="boot-error" role="alert">{error}</p>}
          <div className="btn-row">
            <Button disabled={busy} onClick={() => setForm(null)} variant="text">Cancel</Button>
            <Button loading={busy} type="submit" variant="filled">{form === "add" ? "Send verification" : "Change password"}</Button>
          </div>
        </form>
      )}
    </Card>
  );
}
