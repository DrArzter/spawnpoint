import { useEffect, useRef, useState } from "react";

import { AuthState, exchangeTelegramOidc, telegramOidcClientId } from "../auth";
import type { TelegramLoginResult } from "../telegram";
import { Button } from "./ui/Button";

// The one sign-in control: loads Telegram's OIDC SDK once, opens its popup,
// and hands the resulting token to the access API.
export function TelegramLoginButton({ onChange, onToken, className, label = "Continue with Telegram", variant = "filled" }: Readonly<{
  onChange?: (state: AuthState) => void;
  onToken?: (idToken: string) => Promise<void>;
  className?: string;
  label?: string;
  // Filled where Telegram is the one way in; outlined where it stands beside a
  // form, so one surface carries one primary action.
  variant?: "filled" | "outlined";
}>) {
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
    const clientId = Number(telegramOidcClientId);
    if (!Number.isSafeInteger(clientId) || clientId <= 0) {
      setLoginError("Telegram OIDC is missing its Client ID.");
      return;
    }

    const complete = (result: TelegramLoginResult) => {
      if (typeof result.id_token !== "string") {
        if (mounted.current) setLoginError(result.error || "Telegram did not return an identity token.");
        return;
      }
      if (onTokenRef.current !== undefined) {
        setBusy(true);
        void onTokenRef.current(result.id_token)
          .catch((cause) => { if (mounted.current) setLoginError(cause instanceof Error ? cause.message : "Telegram could not link this account."); })
          .finally(() => { if (mounted.current) setBusy(false); });
      } else if (onChangeRef.current !== undefined) {
        onChangeRef.current({ status: "loading" });
        void exchangeTelegramOidc(result.id_token).then((state) => onChangeRef.current?.(state));
      }
    };
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://oauth.telegram.org/js/telegram-login.js?6";
    script.onload = () => {
      window.Telegram?.Login?.init({ client_id: clientId }, complete);
      if (mounted.current) setSdkReady(window.Telegram?.Login !== undefined);
    };
    script.onerror = () => { if (mounted.current) setLoginError("Telegram sign-in could not load."); };
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
        <Button onClick={() => { setLoginError(""); setSdkReady(false); setAttempt((value) => value + 1); }}>Try again</Button>
      </div>}
    </div>
  );
}
