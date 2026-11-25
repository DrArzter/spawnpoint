import { useState } from "react";

import { useApi } from "../api/context";
import type { AuthState } from "../api/contract";
import { Avatar } from "../components/Avatar";
import { SignInPanel } from "../components/SignIn";
import { Button } from "../components/ui/Button";
import { SpawnpointMark } from "../shell/AppBar";
import { t } from "../i18n";

function visitorAccount(auth: AuthState): string {
  if (auth.status !== "authenticated" || auth.session.state !== "visitor") return "";
  const candidate = auth.session.candidate;
  if (candidate.telegramId === null) return candidate.email ?? candidate.platformUserId;
  const username = candidate.username ? ` · @${candidate.username}` : "";
  return t("signin.telegramIDTelegramIdUsername", { telegramId: candidate.telegramId, username });
}

export function AuthScreen({ auth, onChange }: Readonly<{ auth: AuthState; onChange: (state: AuthState) => void }>) {
  const api = useApi();
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState("");
  const visitor = auth.status === "authenticated" && auth.session.state === "visitor" ? auth.session : null;
  const requested = visitor?.candidate.status === "REQUESTED" || requesting;
  // The account the person is signed in through, in the platform's own terms.
  const account = visitorAccount(auth);

  async function sendRequest() {
    setRequestError("");
    try {
      await api.requestAccess();
      setRequesting(true);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : t("common.accessRequestCouldNot"));
    }
  }

  return (
    <main className="boot">
      <section aria-busy={auth.status === "loading"} className="boot-card">
        <div className="boot-brand"><SpawnpointMark size={48} /><strong>Spawnpoint</strong></div>
        {auth.status === "loading" && <>
          <div className="boot-copy"><h1>{t("common.checkingSession")}</h1><p>{t("common.confirmingWhoAccessAPI")}</p></div>
          <div aria-hidden="true" className="boot-progress" />
        </>}
        {auth.status === "signed-out" && <>
          <div className="boot-copy"><h1>{t("common.sign")}</h1><p>{t("signin.spawnpointHoldsNoAWS")}</p></div>
          <SignInPanel onChange={onChange} />
        </>}
        {auth.status === "unconfigured" && <div className="boot-copy"><h1>{t("signin.signInNotConfigured")}</h1><p>{t("signin.deploymentMissingAccessAPI")}</p></div>}
        {auth.status === "error" && <>
          <div className="boot-copy"><h1>{t("signin.couldNotSign")}</h1><p className="boot-error">{auth.message}</p></div>
          <Button onClick={() => onChange({ status: "signed-out" })} variant="filled">{t("common.tryAgain")}</Button>
        </>}
        {visitor && <>
          <Avatar name={visitor.candidate.displayName} photoUrl={visitor.candidate.photoUrl} size="large" />
          <div className="boot-copy">
            <h1>{requested ? t("common.accessRequested") : t("common.requestAccess")}</h1>
            <p>{requested ? t("signin.ownerWillReviewRequest") : t("signin.signedButAccountHas")}</p>
          </div>
          {!requested && <Button disabled={requesting} onClick={() => void sendRequest()} variant="filled">{t("common.requestAccess")}</Button>}
          {requestError && <p className="boot-error" role="alert">{requestError}</p>}
          <small>{account}</small>
        </>}
      </section>
    </main>
  );
}

export function BootScreen({ title, description }: Readonly<{ title: string; description?: string }>) {
  return (
    <main aria-busy="true" aria-live="polite" className="boot" role="status">
      <section className="boot-card">
        <div className="boot-brand"><SpawnpointMark size={48} /><strong>Spawnpoint</strong></div>
        <div className="boot-copy"><h1>{title}</h1>{description && <p>{description}</p>}</div>
        <div aria-hidden="true" className="boot-progress" />
      </section>
    </main>
  );
}
