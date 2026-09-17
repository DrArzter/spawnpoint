import { useEffect, useState, type FormEvent } from "react";

import { AuthState, loadLoginProviders, LoginProviderId, registerWithPassword, signInWithPassword, telegramOidcClientId } from "../auth";
import { DISPLAY_NAME_MAXIMUM_LENGTH, PASSWORD_MAXIMUM_LENGTH, PASSWORD_MINIMUM_LENGTH } from "../lib/signin";
import { TelegramLoginButton } from "./TelegramLogin";
import { Button } from "./ui/Button";
import { TextField } from "./ui/Fields";

export type SignInMode = "sign-in" | "register";

// The one way in, drawn wherever somebody is asked to sign in: the email and
// password form first, then every other provider this deployment offers as an
// alternative beneath it. One form both creates an account and signs into one;
// only the fields and the verb change.
export function SignInPanel({ onChange, initialMode = "sign-in" }: Readonly<{ onChange: (state: AuthState) => void; initialMode?: SignInMode }>) {
  const [providers, setProviders] = useState<readonly LoginProviderId[] | null>(null);
  const [mode, setMode] = useState<SignInMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void loadLoginProviders().then((offered) => { if (active) setProviders(offered); });
    return () => { active = false; };
  }, []);

  const registering = mode === "register";
  const passwordOffered = providers?.includes("password") ?? false;
  // Telegram needs both the API to accept it and this build to know the public client id.
  const telegramOffered = (providers?.includes("telegram") ?? false) && /^[1-9]\d+$/.test(telegramOidcClientId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      onChange(registering
        ? await registerWithPassword(email, password, displayName)
        : await signInWithPassword(email, password));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in did not complete. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: SignInMode) {
    setMode(next);
    setError("");
  }

  if (providers === null) return <div aria-busy="true" aria-label="Loading the ways to sign in" className="boot-progress" role="status" />;

  return (
    <div className="signin">
      {passwordOffered && (
        <form className="signin-form" onSubmit={(event) => void submit(event)}>
          {registering && (
            <TextField autoComplete="nickname" label="Display name" maxLength={DISPLAY_NAME_MAXIMUM_LENGTH} onChange={(event) => setDisplayName(event.target.value)} placeholder="How other players see you" required value={displayName} />
          )}
          <TextField autoComplete="email" data-autofocus inputMode="email" label="Email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
          <TextField
            autoComplete={registering ? "new-password" : "current-password"}
            hint={registering ? `At least ${PASSWORD_MINIMUM_LENGTH} characters. Length matters more than symbols.` : undefined}
            label="Password"
            maxLength={PASSWORD_MAXIMUM_LENGTH}
            minLength={registering ? PASSWORD_MINIMUM_LENGTH : undefined}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          {error && <p className="boot-error" role="alert">{error}</p>}
          <Button className="signin-submit" loading={busy} type="submit" variant="filled">{registering ? "Create account" : "Sign in"}</Button>
          <p className="signin-switch">
            <span>{registering ? "Already have an account?" : "New here?"}</span>
            <Button onClick={() => switchMode(registering ? "sign-in" : "register")} size="small" variant="text">{registering ? "Sign in" : "Create an account"}</Button>
          </p>
        </form>
      )}
      {passwordOffered && telegramOffered && <div aria-hidden="true" className="signin-divider"><span>or</span></div>}
      {telegramOffered && <TelegramLoginButton className="telegram-login signin-alternative" label="Continue with Telegram" onChange={onChange} />}
      {!passwordOffered && !telegramOffered && <p className="boot-error" role="alert">This deployment offers no way to sign in from a browser.</p>}
    </div>
  );
}
