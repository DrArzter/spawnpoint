import { useEffect, useState, type FormEvent } from "react";

import { AuthState, resetPassword, verifyEmail } from "../auth";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Fields";
import { PASSWORD_MAXIMUM_LENGTH, PASSWORD_MINIMUM_LENGTH } from "../lib/signin";
import type { EmailActionRoute } from "../routing";
import { SpawnpointMark } from "../shell/AppBar";

function screenTitle(kind: EmailActionRoute["kind"], status: "working" | "form" | "done" | "error"): string {
  if (kind === "verify-email") return "Verifying your email";
  if (status === "done") return "Password changed";
  return "Choose a new password";
}

export function EmailActionScreen({ action, onAuth }: Readonly<{ action: EmailActionRoute; onAuth: (state: AuthState) => void }>) {
  const [status, setStatus] = useState<"working" | "form" | "done" | "error">(action.kind === "verify-email" ? "working" : "form");
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    if (action.kind !== "verify-email") return;
    if (!action.token) {
      setMessage("This verification link is incomplete. Request a new link from the sign-in page.");
      setStatus("error");
      return;
    }
    let active = true;
    void verifyEmail(action.token)
      .then((auth) => {
        if (!active) return;
        onAuth(auth);
        window.location.hash = "#/worlds";
      })
      .catch((error) => {
        if (!active) return;
        setMessage(error instanceof Error ? error.message : "This verification link could not be used.");
        setStatus("error");
      });
    return () => { active = false; };
  }, [action.kind, action.token, onAuth]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    if (!action.token) {
      setMessage("This reset link is incomplete. Request a new one from the sign-in page.");
      return;
    }
    if (password !== confirmation) {
      setMessage("The passwords do not match.");
      return;
    }
    setStatus("working");
    try {
      await resetPassword(action.token, password);
      setStatus("done");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Your password could not be reset.");
      setStatus("form");
    }
  }

  return (
    <main className="boot">
      <section aria-busy={status === "working"} className="boot-card">
        <div className="boot-brand"><SpawnpointMark size={48} /><strong>Spawnpoint</strong></div>
        <div className="boot-copy">
          <h1>{screenTitle(action.kind, status)}</h1>
          {action.kind === "verify-email" && status === "working" && <p>Checking this one-time link with the access API.</p>}
          {status === "done" && <p>Your new password is ready. Existing password sessions have been signed out.</p>}
          {status === "error" && <p className="boot-error" role="alert">{message}</p>}
        </div>
        {action.kind === "reset-password" && (status === "form" || status === "working") && (
          <form className="signin-form" onSubmit={(event) => void submit(event)}>
            <TextField autoComplete="new-password" disabled={status === "working"} hint={`At least ${PASSWORD_MINIMUM_LENGTH} characters.`} label="New password" maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
            <TextField autoComplete="new-password" disabled={status === "working"} label="Confirm new password" maxLength={PASSWORD_MAXIMUM_LENGTH} minLength={PASSWORD_MINIMUM_LENGTH} onChange={(event) => setConfirmation(event.target.value)} required type="password" value={confirmation} />
            {message && <p className="boot-error" role="alert">{message}</p>}
            <Button loading={status === "working"} type="submit" variant="filled">Change password</Button>
          </form>
        )}
        {status === "working" && action.kind === "verify-email" && <div aria-hidden="true" className="boot-progress" />}
        {(status === "done" || status === "error") && <Button onClick={() => { window.location.hash = "#/welcome"; }} variant="filled">Return to sign in</Button>}
      </section>
    </main>
  );
}
