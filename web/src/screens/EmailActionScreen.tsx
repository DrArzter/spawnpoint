import { useEffect, useState, type FormEvent } from "react";

import { useApi } from "../api/context";
import type { AuthState } from "../api/contract";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Fields";
import { PASSWORD_MAXIMUM_LENGTH, PASSWORD_MINIMUM_LENGTH } from "../lib/signin";
import type { EmailActionRoute } from "../routing";
import { SpawnpointMark } from "../shell/AppBar";
import { t } from "../i18n";

function screenTitle(kind: EmailActionRoute["kind"], status: "working" | "form" | "done" | "error"): string {
  if (kind === "verify-email") return t("email.verifyingEmail");
  if (status === "done") return t("email.passwordChanged");
  return t("email.chooseNewPassword");
}

export function EmailActionScreen({ action, onAuth }: Readonly<{ action: EmailActionRoute; onAuth: (state: AuthState) => void }>) {
  const api = useApi();
  const [status, setStatus] = useState<"working" | "form" | "done" | "error">(action.kind === "verify-email" ? "working" : "form");
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    if (action.kind !== "verify-email") return;
    if (!action.token) {
      setMessage(t("email.verificationLinkIncompleteRequest"));
      setStatus("error");
      return;
    }
    let active = true;
    void api.verifyEmail(action.token)
      .then((auth) => {
        if (!active) return;
        onAuth(auth);
        const pendingInvite = action.invitationToken ?? window.sessionStorage.getItem("spawnpoint.pending-access-invitation");
        window.location.hash = pendingInvite ? `#/join?token=${encodeURIComponent(pendingInvite)}` : "#/worlds";
      })
      .catch((error) => {
        if (!active) return;
        setMessage(error instanceof Error ? error.message : t("email.verificationLinkCouldNot"));
        setStatus("error");
      });
    return () => { active = false; };
  }, [action.kind, action.token, onAuth]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    if (!action.token) {
      setMessage(t("email.resetLinkIncompleteRequest"));
      return;
    }
    if (password !== confirmation) {
      setMessage(t("common.passwordsDoNotMatch"));
      return;
    }
    setStatus("working");
    try {
      await api.resetPassword(action.token, password);
      setStatus("done");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("email.passwordCouldNotReset"));
      setStatus("form");
    }
  }

  return (
    <main className="boot">
      <section aria-busy={status === "working"} className="boot-card">
        <div className="boot-brand"><SpawnpointMark size={48} /><strong>Spawnpoint</strong></div>
        <div className="boot-copy">
          <h1>{screenTitle(action.kind, status)}</h1>
          {action.kind === "verify-email" && status === "working" && <p>{t("email.checkingOneTimeLinkAccess")}</p>}
          {status === "done" && <p>{t("email.newPasswordReadyExisting")}</p>}
          {status === "error" && <p className="boot-error" role="alert">{message}</p>}
        </div>
        {action.kind === "reset-password" && (status === "form" || status === "working") && (
          <form className="signin-form" onSubmit={(event) => void submit(event)}>
            <TextField autoComplete="new-password" disabled={status === "working"} hint={t("common.leastPASSWORDMINIMUMLENGTH", { PASSWORD_MINIMUM_LENGTH })} label={t("common.newPassword")} maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
            <TextField autoComplete="new-password" disabled={status === "working"} label={t("email.confirmNewPassword")} maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => setConfirmation(event.target.value)} required type="password" value={confirmation} />
            {message && <p className="boot-error" role="alert">{message}</p>}
            <Button loading={status === "working"} type="submit" variant="filled">{t("common.changePassword")}</Button>
          </form>
        )}
        {status === "working" && action.kind === "verify-email" && <div aria-hidden="true" className="boot-progress" />}
        {(status === "done" || status === "error") && <Button onClick={() => { window.location.hash = "#/welcome"; }} variant="filled">{t("email.returnSign")}</Button>}
      </section>
    </main>
  );
}
