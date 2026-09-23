import { useEffect, useState, type FormEvent } from "react";

import { AccessInvitation, createAccessInvitation, loadAccessInvitations, loadLoginOptions, revokeAccessInvitation } from "../auth";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Fields";
import { useSnackbar } from "../components/ui/Snackbar";
import { Banner, Card, EmptyState } from "../components/ui/Surfaces";
import { formatDateTime } from "../lib/format";

export function AccessInvitations() {
  const notify = useSnackbar();
  const [invitations, setInvitations] = useState<AccessInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [linkId, setLinkId] = useState("");
  const [linkEmail, setLinkEmail] = useState("");
  const [emailMode, setEmailMode] = useState<boolean | null>(null);

  async function reload() {
    try {
      setInvitations(await loadAccessInvitations());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invitations could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(); void loadLoginOptions().then((options) => setEmailMode(options.emailActions)); }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setLink("");
    setLinkId("");
    try {
      const recipient = emailMode ? email.trim() : null;
      const issued = await createAccessInvitation(recipient);
      setLink(issued.url);
      setLinkId(issued.id);
      setLinkEmail(recipient ?? "");
      setEmail("");
      notify({ tone: issued.delivery === "failed" ? "error" : "success", message: issued.delivery === "failed" ? "Invitation created, but the email could not be sent. Copy the link below." : "Invitation created." });
      await reload();
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "The invitation could not be created." });
    } finally {
      setCreating(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      notify({ tone: "success", message: "Invitation link copied." });
    } catch {
      notify({ tone: "error", message: "Clipboard access failed. Select and copy the link manually." });
    }
  }

  async function revoke(invitation: AccessInvitation) {
    setRevoking(invitation.id);
    try {
      await revokeAccessInvitation(invitation.id);
      if (linkId === invitation.id) { setLink(""); setLinkId(""); }
      await reload();
      notify({ message: "Invitation revoked." });
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "The invitation could not be revoked." });
    } finally {
      setRevoking(null);
    }
  }

  return <Card title="Invite to Spawnpoint" description="Invite someone to the project, not to a particular world. They choose how to sign in and join as a Viewer.">
    <form className="access-invite-form" onSubmit={(event) => void create(event)}>
      {emailMode && <TextField autoComplete="email" hint="The invitation is valid only after this address is verified." label="Invite email" onChange={(event) => setEmail(event.target.value)} placeholder="person@example.com" required type="email" value={email} />}
      {emailMode === false && <p>This deployment has no email delivery. Share the one-time link yourself; the recipient signs in with an enabled provider.</p>}
      <Button disabled={emailMode === null} loading={creating} type="submit" variant="filled">Create invitation</Button>
    </form>
    {link && <div className="access-invite-link">
      <p>{linkEmail ? `This one-time link is for ${linkEmail}. The recipient must verify that address.` : "This one-time link is not email-bound."} Copy it now; it will not be shown again.</p>
      <TextField label="Invitation link" onFocus={(event) => event.currentTarget.select()} readOnly value={link} />
      <Button onClick={() => void copy()} variant="outlined">Copy link</Button>
    </div>}
    {error && <Banner description={error} title="Invitations could not be loaded" tone="error" />}
    {loading ? <p>Loading invitations…</p> : invitations.length === 0 ? <EmptyState description="Create a link to let someone join with their preferred sign-in method." icon="person_add" title="No invitations yet" /> : <div className="access-invite-list">
      <h3>Recent invitations</h3>
      <ul>
        {invitations.map((invitation) => <li key={invitation.id}>
          <span><strong>{invitation.deliveryEmail ?? "Shareable link"}</strong><small>{invitation.status.toLowerCase()} · Created {formatDateTime(invitation.createdAt)} · Expires {formatDateTime(invitation.expiresAt)}{invitation.delivery === "failed" ? " · Email failed" : ""}</small></span>
          {invitation.status === "PENDING" && <Button loading={revoking === invitation.id} onClick={() => void revoke(invitation)} size="small" variant="text">Revoke</Button>}
        </li>)}
      </ul>
    </div>}
  </Card>;
}
