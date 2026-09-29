import { useEffect, useState } from "react";

import type { AuthState } from "../auth";
import { inspectOAuthAuthorization, decideOAuthAuthorization, type OAuthAuthorizationSummary } from "../api/live/oauth";
import { SignInPanel } from "../components/SignIn";
import { ActionRow, Button } from "../components/ui/Button";
import { Icon } from "../icons";
import { SpawnpointMark } from "../shell/AppBar";

const scopeLabels: Readonly<Record<string, string>> = {
  "spawnpoint.read": "Read worlds, status, metrics, backups and your profile",
  "spawnpoint.operate": "Start and stop worlds you already have permission to operate",
};

export function ConnectScreen({ auth, request, onAuth }: { auth: AuthState; request: string; onAuth: (state: AuthState) => void }) {
  const [summary, setSummary] = useState<OAuthAuthorizationSummary | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const active = auth.status === "authenticated" && auth.session.state === "active";

  useEffect(() => {
    if (!active) return;
    let current = true;
    inspectOAuthAuthorization(request)
      .then((value) => { if (current) setSummary(value); })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "The connection request is no longer valid."); });
    return () => { current = false; };
  }, [active, request]);

  async function decide(approved: boolean) {
    setSubmitting(true);
    setError("");
    try {
      window.location.assign(await decideOAuthAuthorization(request, approved));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not finish the connection.");
      setSubmitting(false);
    }
  }

  return (
    <main className="boot connect-page">
      <section aria-busy={active && summary === null && error === ""} className="boot-card connect-card">
        <div className="connect-brands" aria-hidden="true">
          <SpawnpointMark size={48} />
          <Icon name="chevron_right" size={24} />
          <span className="connect-client-mark">{summary?.client.name.slice(0, 1).toUpperCase() ?? "C"}</span>
        </div>
        <div className="boot-copy">
          <h1>{summary ? `Connect ${summary.client.name}` : "Connect to Spawnpoint"}</h1>
          {summary && <code className="connect-origin">{summary.client.redirectOrigin}</code>}
          {!active && <p>Sign in to approve this connection.</p>}
        </div>
        {!active && auth.status === "signed-out" && <SignInPanel onChange={onAuth} />}
        {!active && auth.status === "error" && <p className="boot-error" role="alert">{auth.message}</p>}
        {!active && auth.status === "unconfigured" && <p className="boot-error" role="alert">Sign-in is not configured.</p>}
        {auth.status === "authenticated" && auth.session.state === "visitor" && <p className="boot-error" role="alert">Spawnpoint access is required.</p>}
        {active && summary && <>
          <ul className="connect-scopes">
            {summary.scopes.map((scope) => <li key={scope}><Icon name="check" size={18} /><span>{scopeLabels[scope] ?? scope}</span></li>)}
          </ul>
          <ActionRow>
            <Button disabled={submitting} onClick={() => void decide(false)} variant="text">Cancel</Button>
            <Button loading={submitting} onClick={() => void decide(true)} variant="filled">Allow</Button>
          </ActionRow>
        </>}
        {active && summary === null && error === "" && <div aria-hidden="true" className="boot-progress" />}
        {error && <p className="boot-error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
