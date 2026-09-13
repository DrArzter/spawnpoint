import { useEffect, useRef, useState } from "react";

import { AuthState, exchangeTelegramOidc, requestAccess, telegramOidcClientId } from "../auth";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/ui/Button";
import { SpawnpointMark } from "../shell/AppBar";
import type { TelegramLoginResult } from "../telegram";

export function AuthScreen({ auth, onChange }: { auth: AuthState; onChange: (state: AuthState) => void }) {
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState("");
  const visitor = auth.status === "authenticated" && auth.session.state === "visitor" ? auth.session : null;
  const requested = visitor?.candidate.status === "REQUESTED" || requesting;

  async function sendRequest() {
    setRequestError("");
    try {
      await requestAccess();
      setRequesting(true);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The access request could not be sent.");
    }
  }

  return (
    <main className="boot">
      <section aria-busy={auth.status === "loading"} className="boot-card">
        <div className="boot-brand"><SpawnpointMark size={48} /><strong>Spawnpoint</strong></div>
        {auth.status === "loading" && <>
          <div className="boot-copy"><h1>Checking your session</h1><p>Verifying your Telegram sign-in with the access API.</p></div>
          <div aria-hidden="true" className="boot-progress" />
        </>}
        {auth.status === "signed-out" && <>
          <div className="boot-copy"><h1>Sign in</h1><p>Continue with Telegram. Spawnpoint keeps no password and no AWS credential in the browser.</p></div>
          <TelegramLoginButton onChange={onChange} />
        </>}
        {auth.status === "unconfigured" && <div className="boot-copy"><h1>Sign-in is not configured</h1><p>This deployment is missing its access API URL or Telegram OIDC Client ID.</p></div>}
        {auth.status === "error" && <>
          <div className="boot-copy"><h1>Could not sign in</h1><p className="boot-error">{auth.message}</p></div>
          <Button onClick={() => onChange({ status: "signed-out" })} variant="filled">Try again</Button>
        </>}
        {visitor && <>
          <Avatar name={visitor.candidate.displayName} photoUrl={visitor.candidate.photoUrl} size="large" />
          <div className="boot-copy">
            <h1>{requested ? "Access requested" : "Request access"}</h1>
            <p>{requested ? "An owner will review your request. You can close this page." : "Your Telegram account is verified, but it has no Spawnpoint role yet."}</p>
          </div>
          {!requested && <Button disabled={requesting} onClick={() => void sendRequest()} variant="filled">Request access</Button>}
          {requestError && <p className="boot-error" role="alert">{requestError}</p>}
          <small>Telegram ID {visitor.candidate.telegramId}{visitor.candidate.username ? ` · @${visitor.candidate.username}` : ""}</small>
        </>}
      </section>
    </main>
  );
}

function TelegramLoginButton({ onChange }: { onChange: (state: AuthState) => void }) {
  const mounted = useRef(true);
  const [sdkReady, setSdkReady] = useState(false);
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
      onChange({ status: "loading" });
      void exchangeTelegramOidc(result.id_token).then(onChange);
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
  }, [attempt, onChange]);

  function openLogin() {
    setLoginError("");
    window.Telegram?.Login?.open();
  }

  return (
    <div className="telegram-login">
      {!loginError && <Button disabled={!sdkReady} onClick={openLogin} variant="filled">Continue with Telegram</Button>}
      {loginError && <div className="boot-copy" role="alert">
        <p className="boot-error">{loginError}</p>
        <Button onClick={() => { setLoginError(""); setSdkReady(false); setAttempt((value) => value + 1); }}>Try again</Button>
      </div>}
    </div>
  );
}

export function BootScreen({ title, description }: { title: string; description: string }) {
  return (
    <main aria-busy="true" aria-live="polite" className="boot" role="status">
      <section className="boot-card">
        <div className="boot-brand"><SpawnpointMark size={48} /><strong>Spawnpoint</strong></div>
        <div className="boot-copy"><h1>{title}</h1><p>{description}</p></div>
        <div aria-hidden="true" className="boot-progress" />
      </section>
    </main>
  );
}
