import { useEffect, useRef, useState } from "react";

import { AuthState, requestAccess, telegramBotUsername, telegramLoginRedirectUrl } from "../auth";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/ui/Button";
import { SpawnpointMark } from "../shell/AppBar";

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
          <TelegramLoginButton />
        </>}
        {auth.status === "unconfigured" && <div className="boot-copy"><h1>Sign-in is not configured</h1><p>This deployment is missing its access API URL or Telegram bot username.</p></div>}
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

function TelegramLoginButton() {
  const host = useRef<HTMLDivElement>(null);
  const [widgetFailed, setWidgetFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const container = host.current;
    if (container === null) return;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.dataset.telegramLogin = telegramBotUsername;
    script.dataset.size = "large";
    script.dataset.radius = "4";
    script.dataset.userpic = "false";
    script.dataset.authUrl = telegramLoginRedirectUrl();
    script.onerror = () => setWidgetFailed(true);
    container.replaceChildren(script);
    return () => container.replaceChildren();
  }, [attempt]);

  return (
    <div className="telegram-login">
      {!widgetFailed && <div ref={host} />}
      {widgetFailed && <div className="boot-copy" role="alert">
        <p className="boot-error">Telegram sign-in could not load.</p>
        <Button onClick={() => { setWidgetFailed(false); setAttempt((value) => value + 1); }}>Try again</Button>
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
