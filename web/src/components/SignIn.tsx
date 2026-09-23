import { useEffect, useState, type FormEvent } from "react";

import {
  AuthState,
  loadLoginOptions,
  LoginOptions,
  registerWithPassword,
  requestPasswordReset,
  resendEmailVerification,
  signInWithPassword,
  telegramOidcClientId,
} from "../auth";
import { DISPLAY_NAME_MAXIMUM_LENGTH, PASSWORD_MAXIMUM_LENGTH, PASSWORD_MINIMUM_LENGTH } from "../lib/signin";
import { TelegramLoginButton } from "./TelegramLogin";
import { Button } from "./ui/Button";
import { TextField } from "./ui/Fields";

export type SignInMode = "sign-in" | "register" | "forgot";

function submitLabel(registering: boolean, recovering: boolean): string {
  if (registering) return "Create account";
  if (recovering) return "Send reset link";
  return "Sign in";
}

// The one way in, drawn wherever somebody is asked to sign in: the email and
// password form first, then every other provider this deployment offers as an
// alternative beneath it. One form both creates an account and signs into one;
// only the fields and the verb change.
export function SignInPanel({ onChange, onModeChange, initialMode = "sign-in", invitationToken }: Readonly<{
  onChange: (state: AuthState) => void;
  // The dialog around this panel titles itself by mode, and the mode changes
  // in here; without this the title says "Sign in" over a registration form.
  onModeChange?: (mode: SignInMode) => void;
  initialMode?: SignInMode;
  invitationToken?: string;
}>) {
  const [options, setOptions] = useState<LoginOptions | null>(null);
  const [mode, setMode] = useState<SignInMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<{ kind: "verification" | "reset"; email: string } | null>(null);

  useEffect(() => {
    let active = true;
    void loadLoginOptions().then((offered) => { if (active) setOptions(offered); });
    return () => { active = false; };
  }, []);

  const passwordRegistrationOffered = options?.selfRegistration.includes("password") ?? false;
  const registering = mode === "register" && passwordRegistrationOffered;
  const recovering = mode === "forgot" && options?.emailActions === true;
  const passwordOffered = options?.providers.includes("password") ?? false;
  // Telegram needs both the API to accept it and this build to know the public client id.
  const telegramOffered = (options?.providers.includes("telegram") ?? false) && /^[1-9]\d+$/.test(telegramOidcClientId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (registering) {
        const result = await registerWithPassword(email, password, displayName, invitationToken);
        setSent({ kind: "verification", email: result.email });
      } else if (recovering) {
        await requestPasswordReset(email);
        setSent({ kind: "reset", email });
      } else {
        onChange(await signInWithPassword(email, password));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in did not complete. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: SignInMode) {
    setMode(next);
    setError("");
    setSent(null);
    onModeChange?.(next);
  }

  if (options === null) return <output aria-label="Loading the ways to sign in" className="boot-progress" />;

  if (sent !== null) {
    return (
      <output className="signin signin-sent">
        <div className="boot-copy">
          <h2>Check your email</h2>
          <p>
            {sent.kind === "verification"
              ? `We sent a verification link to ${sent.email}. Open it to finish creating your account.`
              : `If ${sent.email} belongs to an account, its reset link is on the way.`}
          </p>
        </div>
        {sent.kind === "verification" && (
          <Button disabled={busy} onClick={() => {
            setBusy(true);
            setError("");
            void resendEmailVerification(sent.email, invitationToken)
              .catch((cause) => setError(cause instanceof Error ? cause.message : "A new verification email could not be sent."))
              .finally(() => setBusy(false));
          }} variant="outlined">Send another link</Button>
        )}
        {error && <p className="boot-error" role="alert">{error}</p>}
        <Button onClick={() => switchMode("sign-in")} variant="text">Back to sign in</Button>
      </output>
    );
  }

  return (
    <div className="signin">
      {passwordOffered && (
        <form className="signin-form" onSubmit={(event) => void submit(event)}>
          {registering && (
            <TextField autoComplete="nickname" label="Display name" maxLength={DISPLAY_NAME_MAXIMUM_LENGTH} onChange={(event) => setDisplayName(event.target.value)} placeholder="How other players see you" required value={displayName} />
          )}
          <TextField autoComplete="email" data-autofocus inputMode="email" label="Email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
          {!recovering && <TextField
            autoComplete={registering ? "new-password" : "current-password"}
            hint={registering ? `At least ${PASSWORD_MINIMUM_LENGTH} characters. Length matters more than symbols.` : undefined}
            label="Password"
            maxLength={PASSWORD_MAXIMUM_LENGTH}
            minLength={registering ? PASSWORD_MINIMUM_LENGTH : undefined}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />}
          {!registering && !recovering && options.emailActions && (
            <div className="signin-forgot">
              <Button onClick={() => switchMode("forgot")} size="small" variant="text">Forgot password?</Button>
            </div>
          )}
          {error && <p className="boot-error" role="alert">{error}</p>}
          {/* One row, as every dialog here ends: the way out of this mode on the
              left, the one filled action on the right. */}
          <div className="signin-actions">
            {recovering && <Button onClick={() => switchMode("sign-in")} variant="text">Back to sign in</Button>}
            {!recovering && (registering || passwordRegistrationOffered) && (
              <Button onClick={() => switchMode(registering ? "sign-in" : "register")} variant="text">
                {registering ? "Sign in instead" : "Create an account"}
              </Button>
            )}
            <Button loading={busy} type="submit" variant="filled">{submitLabel(registering, recovering)}</Button>
          </div>
        </form>
      )}
      {passwordOffered && telegramOffered && <div aria-hidden="true" className="signin-divider"><span>or</span></div>}
      {telegramOffered && <TelegramLoginButton className="telegram-login signin-alternative" label="Continue with Telegram" onChange={onChange} variant={passwordOffered ? "outlined" : "filled"} />}
      {!passwordOffered && !telegramOffered && <p className="boot-error" role="alert">This deployment offers no way to sign in from a browser.</p>}
    </div>
  );
}
