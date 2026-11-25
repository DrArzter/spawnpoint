import { useEffect, useState } from "react";

import { useApi } from "../api/context";
import type { AuthState } from "../api/contract";
import { SignInPanel } from "../components/SignIn";
import { Button } from "../components/ui/Button";
import { SpawnpointMark } from "../shell/AppBar";
import { t } from "../i18n";

const pendingInvitationKey = "spawnpoint.pending-access-invitation";

export function JoinScreen({ auth, onAuth, token, proof }: Readonly<{ auth: AuthState; onAuth: (state: AuthState) => void; token: string; proof: string | null }>) {
  const api = useApi();
  const [validity, setValidity] = useState<"checking" | "valid" | "invalid" | "error">("checking");
  const [invitedEmail, setInvitedEmail] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [proofSent, setProofSent] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    if (token) window.sessionStorage.setItem(pendingInvitationKey, token);
    void api.checkAccessInvitation(token)
      .then((result) => { if (active) { setValidity(result.valid ? "valid" : "invalid"); setInvitedEmail(result.email); } })
      .catch(() => { if (active) setValidity("error"); });
    return () => { active = false; };
  }, [token]);

  async function accept() {
    setError("");
    setAccepting(true);
    try {
      await api.redeemAccessInvitation(token, proof ?? undefined);
      window.sessionStorage.removeItem(pendingInvitationKey);
      onAuth(await api.restoreSession());
      window.location.hash = "#/worlds";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("join.invitationCouldNotAccepted"));
    } finally {
      setAccepting(false);
    }
  }

  async function sendProof() {
    setError("");
    setAccepting(true);
    try {
      await api.requestAccessInvitationProof(token);
      setProofSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("common.confirmationEmailCouldNot"));
    } finally {
      setAccepting(false);
    }
  }

  async function useDifferentAccount() {
    setAccepting(true);
    try {
      await api.revokeSession();
      onAuth({ status: "signed-out" });
    } finally {
      setAccepting(false);
    }
  }

  const visitorSession = auth.status === "authenticated" && auth.session.state === "visitor" ? auth.session : null;
  const visitor = visitorSession !== null;
  const member = auth.status === "authenticated" && auth.session.state === "active";
  const passwordVisitor = visitorSession?.candidate.provider === "password";
  const emailMismatch = Boolean(invitedEmail && passwordVisitor && visitorSession.candidate.email !== invitedEmail);

  return <main className="boot">
    <section aria-busy={validity === "checking" || accepting} className="boot-card">
      <div className="boot-brand"><SpawnpointMark size={48} /><strong>Spawnpoint</strong></div>
      <div className="boot-copy">
        <h1>{t("join.joinSpawnpoint")}</h1>
        {validity === "checking" && <p>{t("join.checkingInvitation")}</p>}
        {validity === "invalid" && <p className="boot-error" role="alert">{t("join.invitationHasExpiredHas")}</p>}
        {validity === "error" && <p className="boot-error" role="alert">{t("join.invitationCouldNotChecked")}</p>}
        {validity === "valid" && !member && <p>{invitedEmail ? t("join.invitationInvitedEmailChooseHow", { invitedEmail }) : t("join.chooseHowSignUse")} {t("join.startsWithViewer")}</p>}
        {validity === "valid" && member && <p>{t("join.accountAlreadyHasAccess")}</p>}
        {emailMismatch && <p className="boot-error" role="alert">{t("join.emailMismatch", { email: invitedEmail ?? "" })}</p>}
        {proofSent && <p>{t("join.confirmationSent", { email: invitedEmail ?? "" })}</p>}
      </div>
      {(validity === "checking" || auth.status === "loading") && <div aria-hidden="true" className="boot-progress" />}
      {validity === "valid" && (auth.status === "signed-out" || auth.status === "error") && <SignInPanel invitationToken={token} onChange={onAuth} />}
      {validity === "valid" && visitor && !invitedEmail && <Button loading={accepting} onClick={() => void accept()} variant="filled">{t("join.acceptInvitation")}</Button>}
      {validity === "valid" && invitedEmail && passwordVisitor && !emailMismatch && <Button loading={accepting} onClick={() => void accept()} variant="filled">{t("join.acceptInvitation")}</Button>}
      {validity === "valid" && invitedEmail && visitor && !passwordVisitor && !proof && <Button loading={accepting} onClick={() => void sendProof()} variant="filled">{proofSent ? t("join.sendAnotherConfirmation") : t("join.confirmInvitedEmail")}</Button>}
      {validity === "valid" && invitedEmail && visitor && !passwordVisitor && proof && <Button loading={accepting} onClick={() => void accept()} variant="filled">{t("join.acceptInvitation")}</Button>}
      {validity === "valid" && member && <Button onClick={() => { window.location.hash = "#/worlds"; }} variant="filled">{t("join.openDashboard")}</Button>}
      {validity === "valid" && (member || emailMismatch) && <Button loading={accepting} onClick={() => void useDifferentAccount()} variant="text">{t("join.useDifferentAccount")}</Button>}
      {error && <p className="boot-error" role="alert">{error}</p>}
      {validity === "error" && <Button onClick={() => { setValidity("checking"); void api.checkAccessInvitation(token).then((result) => { setValidity(result.valid ? "valid" : "invalid"); setInvitedEmail(result.email); }).catch(() => setValidity("error")); }} variant="outlined">{t("common.tryAgain")}</Button>}
    </section>
  </main>;
}
