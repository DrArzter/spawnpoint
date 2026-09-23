import { useEffect, useState } from "react";

import { AuthState, checkAccessInvitation, redeemAccessInvitation, requestAccessInvitationProof, restoreAuth, switchLogin } from "../auth";
import { SignInPanel } from "../components/SignIn";
import { Button } from "../components/ui/Button";
import { SpawnpointMark } from "../shell/AppBar";

const pendingInvitationKey = "spawnpoint.pending-access-invitation";

export function JoinScreen({ auth, onAuth, token, proof }: Readonly<{ auth: AuthState; onAuth: (state: AuthState) => void; token: string; proof: string | null }>) {
  const [validity, setValidity] = useState<"checking" | "valid" | "invalid" | "error">("checking");
  const [invitedEmail, setInvitedEmail] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [proofSent, setProofSent] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    if (token) window.sessionStorage.setItem(pendingInvitationKey, token);
    void checkAccessInvitation(token)
      .then((result) => { if (active) { setValidity(result.valid ? "valid" : "invalid"); setInvitedEmail(result.email); } })
      .catch(() => { if (active) setValidity("error"); });
    return () => { active = false; };
  }, [token]);

  async function accept() {
    setError("");
    setAccepting(true);
    try {
      await redeemAccessInvitation(token, proof ?? undefined);
      window.sessionStorage.removeItem(pendingInvitationKey);
      onAuth(await restoreAuth());
      window.location.hash = "#/worlds";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The invitation could not be accepted. Try again.");
    } finally {
      setAccepting(false);
    }
  }

  async function sendProof() {
    setError("");
    setAccepting(true);
    try {
      await requestAccessInvitationProof(token);
      setProofSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The confirmation email could not be sent.");
    } finally {
      setAccepting(false);
    }
  }

  async function useDifferentAccount() {
    setAccepting(true);
    try {
      await switchLogin();
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
        <h1>Join Spawnpoint</h1>
        {validity === "checking" && <p>Checking your invitation.</p>}
        {validity === "invalid" && <p className="boot-error" role="alert">This invitation has expired or has already been used. Ask an Owner for a new link.</p>}
        {validity === "error" && <p className="boot-error" role="alert">The invitation could not be checked. Try opening the link again.</p>}
        {validity === "valid" && !member && <p>{invitedEmail ? `This invitation is for ${invitedEmail}. Choose how to sign in; you will need to verify that address.` : "Choose how to sign in to use this one-time invitation."} Your account will start with Viewer access.</p>}
        {validity === "valid" && member && <p>This account already has access to Spawnpoint.</p>}
        {emailMismatch && <p className="boot-error" role="alert">This account uses a different email. Sign in with {invitedEmail}, or use Telegram and verify the invited mailbox.</p>}
        {proofSent && <p>We sent a confirmation link to {invitedEmail}. Open it to finish joining.</p>}
      </div>
      {(validity === "checking" || auth.status === "loading") && <div aria-hidden="true" className="boot-progress" />}
      {validity === "valid" && (auth.status === "signed-out" || auth.status === "error") && <SignInPanel invitationToken={token} onChange={onAuth} />}
      {validity === "valid" && visitor && !invitedEmail && <Button loading={accepting} onClick={() => void accept()} variant="filled">Accept invitation</Button>}
      {validity === "valid" && invitedEmail && passwordVisitor && !emailMismatch && <Button loading={accepting} onClick={() => void accept()} variant="filled">Accept invitation</Button>}
      {validity === "valid" && invitedEmail && visitor && !passwordVisitor && !proof && <Button loading={accepting} onClick={() => void sendProof()} variant="filled">{proofSent ? "Send another confirmation" : "Confirm invited email"}</Button>}
      {validity === "valid" && invitedEmail && visitor && !passwordVisitor && proof && <Button loading={accepting} onClick={() => void accept()} variant="filled">Accept invitation</Button>}
      {validity === "valid" && member && <Button onClick={() => { window.location.hash = "#/worlds"; }} variant="filled">Open dashboard</Button>}
      {validity === "valid" && (member || emailMismatch) && <Button loading={accepting} onClick={() => void useDifferentAccount()} variant="text">Use a different account</Button>}
      {error && <p className="boot-error" role="alert">{error}</p>}
      {validity === "error" && <Button onClick={() => { setValidity("checking"); void checkAccessInvitation(token).then((result) => { setValidity(result.valid ? "valid" : "invalid"); setInvitedEmail(result.email); }).catch(() => setValidity("error")); }} variant="outlined">Try again</Button>}
    </section>
  </main>;
}
