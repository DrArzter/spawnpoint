import { useEffect, useRef, useState } from "react";

import { useApi, useSignInConfig } from "../api/context";
import type { AuthState } from "../api/contract";
import type { TelegramLoginResult } from "../telegram";
import { Button } from "./ui/Button";
import { t } from "../i18n";

// The one sign-in control: loads Telegram's OIDC SDK once, opens its popup,
// and hands the resulting token to the access API.
export function TelegramLoginButton({ onChange, onToken, className, label = t("signin.continueTelegram"), variant = "filled" }: Readonly<{
  onChange?: (state: AuthState) => void;
  onToken?: (idToken: string) => Promise<void>;
  className?: string;
  label?: string;
  // Filled where Telegram is the one way in; outlined where it stands beside a
  // form, so one surface carries one primary action.
  variant?: "filled" | "outlined";
}>) {
  const api = useApi();
  const { telegramClientId } = useSignInConfig();
  const mounted = useRef(true);
  const onChangeRef = useRef(onChange);
  const onTokenRef = useRef(onToken);
  onChangeRef.current = onChange;
  onTokenRef.current = onToken;
  const [sdkReady, setSdkReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    mounted.current = true;
    const clientId = Number(telegramClientId);
    if (!Number.isSafeInteger(clientId) || clientId <= 0) {
      setLoginError(t("signin.telegramOIDCMissingClient"));
      return;
    }

    const complete = (result: TelegramLoginResult) => {
      if (typeof result.id_token !== "string") {
        if (mounted.current) setLoginError(result.error || t("signin.telegramDidNotReturn"));
        return;
      }
      if (onTokenRef.current !== undefined) {
        setBusy(true);
        void onTokenRef.current(result.id_token)
          .catch((cause) => { if (mounted.current) setLoginError(cause instanceof Error ? cause.message : t("signin.telegramCouldNotLink")); })
          .finally(() => { if (mounted.current) setBusy(false); });
      } else if (onChangeRef.current !== undefined) {
        onChangeRef.current({ status: "loading" });
        void api.exchangeTelegramOidc(result.id_token).then((state) => onChangeRef.current?.(state));
      }
    };
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://oauth.telegram.org/js/telegram-login.js?6";
    script.onload = () => {
      window.Telegram?.Login?.init({ client_id: clientId }, complete);
      if (mounted.current) setSdkReady(window.Telegram?.Login !== undefined);
    };
    script.onerror = () => { if (mounted.current) setLoginError(t("signin.telegramSignInCouldNot")); };
    document.head.append(script);
    return () => {
      mounted.current = false;
      script.remove();
    };
  }, [attempt]);

  function openLogin() {
    setLoginError("");
    window.Telegram?.Login?.open();
  }

  return (
    <div className={className ?? "telegram-login"}>
      {!loginError && <Button disabled={!sdkReady} icon="send" loading={busy} onClick={openLogin} variant={variant}>{label}</Button>}
      {loginError && <div className="boot-copy" role="alert">
        <p className="boot-error">{loginError}</p>
        <Button onClick={() => { setLoginError(""); setSdkReady(false); setAttempt((value) => value + 1); }}>{t("common.tryAgain")}</Button>
      </div>}
    </div>
  );
}
