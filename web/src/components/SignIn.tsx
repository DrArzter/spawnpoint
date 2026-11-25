import { useEffect, useState, type FormEvent } from "react";

import { useApi, useSignInConfig } from "../api/context";
import type { AuthState, LoginOptions } from "../api/contract";
import { DISPLAY_NAME_MAXIMUM_LENGTH, PASSWORD_MAXIMUM_LENGTH, PASSWORD_MINIMUM_LENGTH } from "../lib/signin";
import { GOOGLE_CLIENT_ID, GoogleLoginButton } from "./GoogleLogin";
import { TelegramLoginButton } from "./TelegramLogin";
import { Button } from "./ui/Button";
import { TextField } from "./ui/Fields";
import { t } from "../i18n";

export type SignInMode = "sign-in" | "register" | "forgot";

function submitLabel(registering: boolean, recovering: boolean): string {
  if (registering) return t("signin.createAccount");
  if (recovering) return t("common.sendResetLink");
  return t("common.sign");
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
  const api = useApi();
  const { telegramClientId, googleClientId } = useSignInConfig();
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
    void api.loadLoginOptions().then((offered) => { if (active) setOptions(offered); });
    return () => { active = false; };
  }, []);

  const passwordRegistrationOffered = options?.selfRegistration.includes("password") ?? false;
  const registering = mode === "register" && passwordRegistrationOffered;
  const recovering = mode === "forgot" && options?.emailActions === true;
  const passwordOffered = options?.providers.includes("password") ?? false;
  // A provider needs both the API to accept it and this build to know its public client id.
  const telegramOffered = (options?.providers.includes("telegram") ?? false) && /^[1-9]\d+$/.test(telegramClientId);
  const googleOffered = (options?.providers.includes("google") ?? false) && GOOGLE_CLIENT_ID.test(googleClientId);
  const alternativesOffered = telegramOffered || googleOffered;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (registering) {
        const result = await api.registerWithPassword(email, password, displayName, invitationToken);
        setSent({ kind: "verification", email: result.email });
      } else if (recovering) {
        await api.requestPasswordReset(email);
        setSent({ kind: "reset", email });
      } else {
        onChange(await api.signInWithPassword(email, password));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("signin.signInDidNotComplete"));
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

  if (options === null) return <output aria-label={t("signin.loadingWaysSign")} className="boot-progress" />;

  if (sent !== null) {
    return (
      <output className="signin signin-sent">
        <div className="boot-copy">
          <h2>{t("signin.checkEmail")}</h2>
          <p>
            {sent.kind === "verification"
              ? t("signin.weSentVerificationLink", { email: sent.email })
              : t("signin.ifEmailBelongsAccount", { email: sent.email })}
          </p>
        </div>
        {sent.kind === "verification" && (
          <Button disabled={busy} onClick={() => {
            setBusy(true);
            setError("");
            void api.resendEmailVerification(sent.email, invitationToken)
              .catch((cause) => setError(cause instanceof Error ? cause.message : t("signin.newVerificationEmailCould")))
              .finally(() => setBusy(false));
          }} variant="outlined">{t("signin.sendAnotherLink")}</Button>
        )}
        {error && <p className="boot-error" role="alert">{error}</p>}
        <Button onClick={() => switchMode("sign-in")} variant="text">{t("signin.backSign")}</Button>
      </output>
    );
  }

  return (
    <div className="signin">
      {passwordOffered && (
        <form className="signin-form" onSubmit={(event) => void submit(event)}>
          {registering && (
            <TextField autoComplete="nickname" label={t("signin.displayName")} maxLength={DISPLAY_NAME_MAXIMUM_LENGTH} onChange={(event) => setDisplayName(event.target.value)} placeholder={t("signin.howOtherPlayersSee")} required value={displayName} />
          )}
          <TextField autoComplete="email" data-autofocus inputMode="email" label={t("common.email")} onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
          {!recovering && <TextField
            autoComplete={registering ? "new-password" : "current-password"}
            hint={registering ? t("signin.leastPASSWORDMINIMUMLENGTH", { PASSWORD_MINIMUM_LENGTH }) : undefined}
            label={t("common.password")}
            maxLength={PASSWORD_MAXIMUM_LENGTH}
            minLength={registering ? PASSWORD_MINIMUM_LENGTH : undefined}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />}
          {!registering && !recovering && options.emailActions && (
            <div className="signin-forgot">
              <Button onClick={() => switchMode("forgot")} size="small" variant="text">{t("signin.forgotPassword")}</Button>
            </div>
          )}
          {error && <p className="boot-error" role="alert">{error}</p>}
          {/* One row, as every dialog here ends: the way out of this mode on the
              left, the one filled action on the right. */}
          <div className="signin-actions">
            {recovering && <Button onClick={() => switchMode("sign-in")} variant="text">{t("signin.backSign")}</Button>}
            {!recovering && (registering || passwordRegistrationOffered) && (
              <Button onClick={() => switchMode(registering ? "sign-in" : "register")} variant="text">
                {registering ? t("signin.signInstead") : t("common.createAccount")}
              </Button>
            )}
            <Button loading={busy} type="submit" variant="filled">{submitLabel(registering, recovering)}</Button>
          </div>
        </form>
      )}
      {passwordOffered && alternativesOffered && <div aria-hidden="true" className="signin-divider"><span>{t("signin.or")}</span></div>}
      {alternativesOffered && (
        <div className="signin-alternatives">
          {telegramOffered && <TelegramLoginButton className="telegram-login signin-alternative" label={t("signin.continueTelegram")} onChange={onChange} variant={passwordOffered ? "outlined" : "filled"} />}
          {googleOffered && <GoogleLoginButton className="google-login signin-alternative" onChange={onChange} />}
        </div>
      )}
      {!passwordOffered && !alternativesOffered && <p className="boot-error" role="alert">{t("signin.deploymentOffersNoWay")}</p>}
    </div>
  );
}
