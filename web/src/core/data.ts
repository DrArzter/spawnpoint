import { useCallback, useEffect, useMemo, useState } from "react";

import type { AccessCandidate, AccessInvitation, ApiFailureKind, BackupEntry, BackupInventory, HostMetrics, InvitationRecipient, InvitationSummary, LinkedLoginAccounts, MetricRange, SubscriptionState } from "../api/contract";
import { failureKind } from "../api/contract";
import {
  approveAccessCandidate, changePassword, createAccessInvitation, dismissAccessCandidate, linkPassword, linkTelegram, loadAccessCandidates, loadAccessIdentities, loadAccessInvitations,
  loadAccessRoles, loadBackups, loadHostMetrics, loadInvitationHistory, loadInvitationRecipients, loadLinkedAccounts, loadLoginOptions, loadSubscriptions, requestPasswordReset, resendEmailVerification, revokeAccessInvitation,
  sendInvitation, telegramOidcClientId, updateIdentityRole, updateSubscriptions,
} from "../auth";
import type { SnackInput } from "../components/ui/Snackbar";
import type { StatusKind } from "../components/ui/Status";
import { formatDateTime } from "../lib/format";
import type { Game, LinkKind, Member, OwnerBootstrap, Role, World } from "../model";
import { action, type Action } from "./actions";
import type { BackupsModel, CandidateRow, InvitationModel, InvitationsModel, Loading, LoginAccountsModel, MetricsModel, NotificationsModel, RolesModel, UsersModel } from "./models";

/*
 * The data each page loads for itself and what may be done with it. Every
 * hook here returns a model and nothing else; the skin that renders it never
 * touches the API. `notify` is how an outcome reaches the person, whatever
 * the skin draws it as.
 */

export type Notify = (input: SnackInput) => void;

type LoadState<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; error: string; kind: ApiFailureKind };

function useLoad<T>(load: (() => Promise<T>) | null, deps: readonly unknown[]): [LoadState<T>, () => void, (update: (value: T) => T) => void] {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (load === null) return;
    let current = true;
    setState({ status: "loading" });
    load()
      .then((value) => { if (current) setState({ status: "ready", value }); })
      .catch((cause: unknown) => { if (current) setState({ status: "error", error: cause instanceof Error ? cause.message : "The request failed.", kind: failureKind(cause) }); });
    return () => { current = false; };
  // The caller names what the load depends on; the loader itself is recreated every render.
  }, [...deps, revision]);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const update = useCallback((updater: (value: T) => T) => setState((current) => (current.status === "ready" ? { status: "ready", value: updater(current.value) } : current)), []);
  return [state, retry, update];
}

function asLoading<T>(state: LoadState<T>, retry: () => void, retryId: string): Loading<T> {
  if (state.status === "error") return { status: "error", error: state.error, kind: state.kind, retry: action(retryId, "Try again", retry) };
  return state;
}

// --- backups -----------------------------------------------------------------

export function useBackups(gameId: string, world: World, opts: Readonly<{ canRead: boolean; canRestore: boolean; busy: boolean; settled: string; onRestore: (entry: BackupEntry) => void }>): BackupsModel {
  const [filter, setFilter] = useState<string | null>(null);
  useEffect(() => { setFilter(null); }, [world.id]);
  const [state, retry] = useLoad<BackupInventory>(opts.canRead ? () => loadBackups(gameId, world.id) : null, [opts.canRead, gameId, world.id, opts.settled]);
  const inventory = useMemo<Loading<{ entries: readonly BackupEntry[]; unverified: number; truncated: boolean }>>(() => {
    if (state.status !== "ready") return asLoading(state, retry, "backups.retry");
    return { status: "ready", value: { entries: state.value.entries.filter((entry) => filter === null || entry.generationId === filter), unverified: state.value.unverified, truncated: state.value.truncated } };
  }, [state, filter, retry]);
  return {
    canRead: opts.canRead,
    canRestore: opts.canRestore,
    filter,
    setFilter,
    wipes: world.wipes,
    inventory,
    wipeNumber: (generationId) => world.wipes.find((wipe) => wipe.id === generationId)?.number,
    restore: (entry) => action("backup.restore", "Restore", () => opts.onRestore(entry), {
      icon: "restore",
      disabled: !world.worldLifecycleAvailable || !opts.canRestore || entry.generationId === null || opts.busy,
      hint: !world.worldLifecycleAvailable ? "This legacy world is not wipe-managed." : entry.generationId === null ? "This legacy backup is not tied to a wipe." : opts.canRestore ? "Restore into a new wipe" : "Your role cannot restore backups.",
    }),
  };
}

// --- metrics -----------------------------------------------------------------

export const METRIC_RANGES: readonly { id: MetricRange; label: string }[] = [
  { id: "6h", label: "6 hours" },
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
];

export function useMetrics(instanceId: string | undefined, online: boolean): MetricsModel {
  const [source, setSource] = useState<"session" | "cloudwatch">("cloudwatch");
  const [range, setRange] = useState<MetricRange>("24h");
  const [state, retry] = useLoad<HostMetrics>(instanceId === undefined ? null : () => loadHostMetrics(instanceId, range), [instanceId, range]);
  return { source, setSource, online, instanceId, range, ranges: METRIC_RANGES, setRange, metrics: asLoading(state, retry, "metrics.retry") };
}

// --- access: users -------------------------------------------------------------

const linkKinds: readonly LinkKind[] = ["telegram", "email", "discord", "minecraft", "factorio", "steam", "zerotier"];

// The platform an account signs in through, as the panel names its links. A
// password account is known by its email, not by its credential id.
function linkKindFor(platform: string): LinkKind | null {
  if (platform === "password") return "email";
  return (linkKinds as readonly string[]).includes(platform) ? platform as LinkKind : null;
}

function linkFor(platform: string, value: string, handle: string | null, verified: boolean): Member["links"][number] | null {
  const kind = linkKindFor(platform);
  if (kind === null) return null;
  return { id: `${kind}-${value}`, kind, value: kind === "email" ? handle ?? value : value, verified };
}

// How a waiting account introduces itself: its Telegram handle, or its email.
function candidateAccount(candidate: AccessCandidate): string {
  if (candidate.platform === "password") return candidate.email ?? "Email account";
  return candidate.username ? `@${candidate.username}` : "Telegram account";
}

export function bootstrapDescription(bootstrap: OwnerBootstrap): string | undefined {
  if (bootstrap.state === "claimed") return undefined;
  const configuredAccount = bootstrap.telegramId ? ` (${bootstrap.telegramId})` : "";
  return `Sign in with the configured Telegram account${configuredAccount} to create the first Owner.`;
}

export function useUsers(opts: Readonly<{ bootstrap: OwnerBootstrap; canInvite: boolean; members: Member[]; roles: Role[]; rolesLoading: boolean; onMembersChange: (members: Member[]) => void; notify: Notify }>): UsersModel {
  const { members, roles, onMembersChange, notify } = opts;
  const [managing, setManaging] = useState<string | null>(null);
  const [candidateRoles, setCandidateRoles] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [state, retry, update] = useLoad<AccessCandidate[]>(() => Promise.all([loadAccessCandidates(), loadAccessIdentities()]).then(([candidates, identities]) => {
    onMembersChange(identities.map((identity) => ({
      id: identity.id,
      name: identity.displayName,
      roleId: identity.roleId,
      links: identity.links.flatMap((link) => { const mapped = linkFor(link.platform, link.value, link.handle, link.verified); return mapped === null ? [] : [mapped]; }),
    })));
    return candidates;
  }), []);
  const invitations = useInvitations(opts.canInvite, notify);

  async function changeRole(member: Member, roleId: string) {
    setWorking(member.id);
    try {
      await updateIdentityRole(member.id, roleId);
      onMembersChange(members.map((item) => (item.id === member.id ? { ...item, roleId } : item)));
      notify({ tone: "success", message: `${member.name} is now ${roles.find((role) => role.id === roleId)?.name ?? roleId}.` });
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "The role could not be changed." });
    } finally {
      setWorking(null);
    }
  }

  async function approve(candidate: AccessCandidate) {
    const roleId = candidateRoles[candidate.platformUserId] ?? "viewer";
    setWorking(candidate.platformUserId);
    try {
      const identity = await approveAccessCandidate(candidate.platform, candidate.platformUserId, roleId);
      update((current) => current.filter((item) => item.platformUserId !== candidate.platformUserId));
      const link = linkFor(candidate.platform, candidate.platformUserId, candidate.username ?? candidate.email, candidate.platform !== "password");
      onMembersChange([...members, { id: identity.id, name: identity.displayName, roleId: identity.roleId, links: link === null ? [] : [link] }]);
      notify({ tone: "success", message: `${identity.displayName} approved as ${roles.find((role) => role.id === identity.roleId)?.name ?? identity.roleId}.` });
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "This account could not be approved." });
    } finally {
      setWorking(null);
    }
  }

  async function dismiss(candidate: AccessCandidate) {
    setWorking(candidate.platformUserId);
    try {
      await dismissAccessCandidate(candidate.platform, candidate.platformUserId);
      update((current) => current.filter((item) => item.platformUserId !== candidate.platformUserId));
      notify({ message: `${candidate.displayName} dismissed.` });
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "This account could not be dismissed." });
    } finally {
      setWorking(null);
    }
  }

  const rolesReady = !opts.rolesLoading && roles.length > 0;
  const candidates: Loading<readonly CandidateRow[]> = state.status !== "ready"
    ? asLoading(state, retry, "access.candidates.retry")
    : {
      status: "ready",
      value: state.value.map((candidate) => ({
        candidate,
        account: candidateAccount(candidate),
        since: `${candidate.status === "REQUESTED" ? "Requested access" : "Signed in"} ${formatDateTime(candidate.status === "REQUESTED" ? candidate.requestedAt : candidate.lastSeenAt)}`,
        roleId: candidateRoles[candidate.platformUserId] ?? "viewer",
        setRoleId: (roleId: string) => setCandidateRoles((current) => ({ ...current, [candidate.platformUserId]: roleId })),
        approve: action("access.approve", "Approve", () => void approve(candidate), { disabled: !rolesReady, busy: working === candidate.platformUserId, hint: rolesReady ? "Approve with the chosen role" : "Roles are still loading" }),
        dismiss: action("access.dismiss", "Dismiss", () => void dismiss(candidate), { disabled: working === candidate.platformUserId }),
      })),
    };

  return {
    bootstrap: opts.bootstrap,
    bootstrapDescription: bootstrapDescription(opts.bootstrap),
    candidates,
    members: members.map((member) => ({
      member,
      roleId: member.roleId,
      setRoleId: (roleId: string) => void changeRole(member, roleId),
      changing: working === member.id,
      linkedAccounts: action("access.linked", "Linked accounts", () => setManaging(member.id), { icon: "link" }),
    })),
    roles,
    rolesLoading: opts.rolesLoading,
    invitations,
    managed: members.find((member) => member.id === managing) ?? null,
    closeManaged: action("sheet.close", "Close panel", () => setManaging(null)),
  };
}

// --- access: invitations to the project -------------------------------------------

function useInvitations(enabled: boolean, notify: Notify): InvitationsModel | null {
  const [email, setEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ url: string; id: string; email: string } | null>(null);
  const [emailMode, setEmailMode] = useState<boolean | null>(null);
  const [state, retry] = useLoad<AccessInvitation[]>(enabled ? () => loadAccessInvitations() : null, [enabled]);
  useEffect(() => { if (enabled) void loadLoginOptions().then((options) => setEmailMode(options.emailActions)); }, [enabled]);
  if (!enabled) return null;

  async function create() {
    setCreating(true);
    setIssued(null);
    try {
      const recipient = emailMode ? email.trim() : null;
      const result = await createAccessInvitation(recipient);
      setIssued({ url: result.url, id: result.id, email: recipient ?? "" });
      setEmail("");
      notify({ tone: result.delivery === "failed" ? "error" : "success", message: result.delivery === "failed" ? "Invitation created, but the email could not be sent. Copy the link below." : "Invitation created." });
      retry();
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "The invitation could not be created." });
    } finally {
      setCreating(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      notify({ tone: "success", message: "Invitation link copied." });
    } catch {
      notify({ tone: "error", message: "Clipboard access failed. Select and copy the link manually." });
    }
  }

  async function revoke(invitation: AccessInvitation) {
    setRevoking(invitation.id);
    try {
      await revokeAccessInvitation(invitation.id);
      if (issued?.id === invitation.id) setIssued(null);
      retry();
      notify({ message: "Invitation revoked." });
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "The invitation could not be revoked." });
    } finally {
      setRevoking(null);
    }
  }

  return {
    emailMode,
    email,
    setEmail,
    create: action("invitation.create", "Create invitation", () => void create(), { disabled: emailMode === null, busy: creating }),
    issued: issued ? { url: issued.url, email: issued.email, copy: action("invitation.copy", "Copy link", () => void copy(issued.url)) } : null,
    list: state.status !== "ready"
      ? asLoading(state, retry, "invitation.retry")
      : { status: "ready", value: state.value.map((invitation) => ({ invitation, revoke: invitation.status === "PENDING" ? action("invitation.revoke", "Revoke", () => void revoke(invitation), { busy: revoking === invitation.id }) : null })) },
  };
}

// --- access: roles --------------------------------------------------------------

export function useRoles(onRolesChange: (roles: Role[]) => void): RolesModel & { loading: boolean } {
  const [reading, setReading] = useState<string | null>(null);
  const [state, retry] = useLoad<Role[]>(() => loadAccessRoles().then((roles) => { onRolesChange(roles); return roles; }), []);
  const roles = state.status === "ready" ? state.value : [];
  return {
    loading: state.status === "loading",
    roles: asLoading(state, retry, "access.roles.retry"),
    reading: roles.find((item) => item.id === reading) ?? null,
    read: (role) => action("access.role.read", `${role.permissions.length} ${role.permissions.length === 1 ? "permission" : "permissions"}`, () => setReading(role.id), { icon: "chevron_right" }),
    closeReading: action("sheet.close", "Close panel", () => setReading(null)),
  };
}

// --- access: notifications ------------------------------------------------------

export function useNotifications(games: readonly Game[], notify: Notify): NotificationsModel {
  const [subscriptions, setSubscriptions] = useState<SubscriptionState>({});
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      setSubscriptions(await loadSubscriptions());
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your notification subscriptions could not be loaded.");
      setState("error");
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function toggle(id: string) {
    if (state === "loading" || state === "saving") return;
    const previous = subscriptions;
    const next = { ...subscriptions, [id]: !subscriptions[id] };
    setSubscriptions(next);
    setState("saving");
    try {
      setSubscriptions(await updateSubscriptions(next));
      setState("ready");
    } catch (cause) {
      setSubscriptions(previous);
      setState("ready");
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "Your notification subscriptions could not be saved." });
    }
  }

  const disabled = state === "loading" || state === "saving";
  return {
    state,
    error,
    retry: state === "error" ? action("notifications.retry", "Try again", () => void reload()) : null,
    saveStatus: state === "saving" ? "Saving…" : state === "ready" ? "Saved to your identity" : "",
    games,
    subscriptions,
    toggle: (id, label) => action(`notifications.${id}`, label, () => void toggle(id), { disabled }),
  };
}

// --- inviting players to a world ---------------------------------------------------

function invitationStatusLabel(status: InvitationSummary["status"]): string {
  const labels: Record<InvitationSummary["status"], string> = {
    READY: "Queued", DELIVERING: "Delivering", DELIVERED: "Delivered", PARTIAL: "Partial",
    FAILED: "Failed", NO_RECIPIENTS: "No recipients", PUBLISH_FAILED: "Queue failed",
  };
  return labels[status];
}

function invitationStatusKind(status: InvitationSummary["status"]): StatusKind {
  if (status === "DELIVERED") return "ok";
  if (status === "FAILED" || status === "PUBLISH_FAILED") return "error";
  if (status === "PARTIAL") return "warning";
  if (status === "READY" || status === "DELIVERING") return "progress";
  return "off";
}

function deliveryDetail(item: InvitationSummary): string {
  if (item.status === "READY" || item.status === "DELIVERING") return "Waiting for the notifier";
  if (item.status === "NO_RECIPIENTS") return "Nobody was subscribed";
  if (item.status === "FAILED" && item.targetCount === 0) return "Delivery process failed";
  if (item.targetCount === null || item.successCount === null) return "No delivery result";
  return `${item.successCount}/${item.targetCount} delivered`;
}

function deliveryLabel(recipient: InvitationRecipient): string {
  if (recipient.delivery === "ready") return "Accepts direct invitations";
  if (recipient.delivery === "notifications_off") return "Direct invitations turned off";
  return "Must open the bot privately first";
}

export function useInvitation(game: Game, world: World, opts: Readonly<{ onClose: () => void; notify: Notify }>): InvitationModel {
  const [audience, setAudience] = useState<"broadcast" | "direct">("broadcast");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState(false);
  const [recipientState, retryRecipients] = useLoad<InvitationRecipient[]>(() => loadInvitationRecipients(), [game.id, world.id]);
  const [historyState, refreshHistory] = useLoad<InvitationSummary[]>(() => loadInvitationHistory(game.id, world.id), [game.id, world.id]);
  const recipients = recipientState.status === "ready" ? recipientState.value : [];
  const needle = query.trim().toLocaleLowerCase();

  function toggle(recipient: InvitationRecipient) {
    if (recipient.delivery !== "ready") return;
    setSelected((current) => { const next = new Set(current); if (next.has(recipient.id)) next.delete(recipient.id); else next.add(recipient.id); return next; });
  }

  async function submit() {
    setSending(true);
    try {
      await sendInvitation(game.id, world.id, audience, [...selected]);
      opts.notify({ tone: "success", message: audience === "broadcast" ? "Invitation accepted for delivery to everyone." : `Invitation accepted for ${selected.size} ${selected.size === 1 ? "player" : "players"}.` });
      setSelected(new Set());
      refreshHistory();
    } catch (error) {
      opts.notify({ tone: "error", message: error instanceof Error ? error.message : "The invitation could not be sent." });
    } finally {
      setSending(false);
    }
  }

  return {
    game,
    world,
    audience,
    setAudience,
    query,
    setQuery,
    recipients: recipientState.status !== "ready"
      ? asLoading(recipientState, retryRecipients, "invitation.recipients.retry")
      : { status: "ready", value: recipients.filter((recipient) => needle === "" || recipient.displayName.toLocaleLowerCase().includes(needle)).map((recipient) => ({ id: recipient.id, displayName: recipient.displayName, ready: recipient.delivery === "ready", delivery: deliveryLabel(recipient), selected: selected.has(recipient.id), toggle: () => toggle(recipient) })) },
    reachable: recipients.filter((recipient) => recipient.delivery === "ready").length,
    selectedCount: selected.size,
    clearSelection: action("invitation.clear", "Clear selection", () => setSelected(new Set()), { disabled: selected.size === 0 }),
    history: historyState.status !== "ready"
      ? asLoading(historyState, refreshHistory, "invitation.history.retry")
      : { status: "ready", value: historyState.value.slice(0, 5).map((item) => ({ id: item.id, status: { kind: invitationStatusKind(item.status), label: invitationStatusLabel(item.status) }, audience: item.audience === "broadcast" ? "Everyone" : `${item.recipientCount ?? 0} selected`, detail: deliveryDetail(item), createdAt: item.createdAt })) },
    refreshHistory: action("invitation.history.refresh", "Refresh", refreshHistory, { icon: "refresh", disabled: historyState.status === "loading" }),
    send: action("invitation.send", "Send invitation", () => void submit(), { icon: "send", busy: sending, disabled: sending || (audience === "direct" && selected.size === 0), hint: audience === "broadcast" ? "One Telegram message to group chats and subscribers." : selected.size === 0 ? "Choose at least one player." : `${selected.size} ${selected.size === 1 ? "player" : "players"} selected.` }),
    close: action("sheet.close", "Close panel", opts.onClose),
  };
}

// --- profile: sign-in methods -------------------------------------------------------

export function useLoginAccounts(displayName: string, notify: Notify): LoginAccountsModel {
  const [state, retry] = useLoad<LinkedLoginAccounts>(() => loadLinkedAccounts(), []);
  const [form, setForm] = useState<"add" | "change" | null>(null);
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = state.status === "ready" ? state.value : null;
  const accounts = ready?.accounts ?? [];
  const passwordAccount = accounts.find((account) => account.provider === "password");

  async function connect(link: (idToken: string) => Promise<void>, label: string, idToken: string) {
    await link(idToken);
    notify({ tone: "success", message: `${label} is now a sign-in method for this identity.` });
    retry();
  }

  function openForm(next: "add" | "change", account?: { email: string | null }) {
    setForm(next);
    setEmail(account?.email ?? "");
    setCurrentPassword("");
    setPassword("");
    setConfirmation("");
    setError("");
  }

  async function submit() {
    setError("");
    if (password !== confirmation) { setError("The passwords do not match."); return; }
    setBusy(true);
    try {
      if (form === "add") {
        await linkPassword(email, password, displayName);
        notify({ tone: "success", message: `A verification link was sent to ${email}.` });
      } else {
        await changePassword(email, currentPassword, password);
        notify({ tone: "success", message: "Password changed. Existing password sessions were signed out." });
      }
      setForm(null);
      retry();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sign-in method could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function recover(kind: "verify" | "reset", address: string) {
    setBusy(true);
    try {
      if (kind === "verify") await resendEmailVerification(address); else await requestPasswordReset(address);
      notify({ tone: "success", message: kind === "verify" ? `A new verification link was sent to ${address}.` : `If the account is eligible, a reset link is on its way to ${address}.` });
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "The email could not be sent." });
    } finally {
      setBusy(false);
    }
  }

  const linkable = ready?.linkableProviders ?? [];
  const has = (provider: string) => accounts.some((account) => account.provider === provider);
  return {
    accounts: state.status !== "ready" ? asLoading(state, retry, "accounts.retry") : { status: "ready", value: accounts },
    linkable,
    connectTelegram: ready !== null && !has("telegram") && linkable.includes("telegram") && /^[1-9]\d+$/.test(telegramOidcClientId) ? (idToken) => connect(linkTelegram, "Telegram", idToken) : null,
    addPassword: ready !== null && passwordAccount === undefined && ready.passwordManagementAvailable ? action("accounts.password.add", "Add email and password", () => openForm("add"), { icon: "add" }) : null,
    form: form === null ? null : {
      kind: form,
      email, setEmail, currentPassword, setCurrentPassword, password, setPassword, confirmation, setConfirmation,
      error,
      busy,
      submit: action("accounts.password.submit", form === "add" ? "Send verification" : "Change password", () => void submit(), { busy }),
      cancel: action("accounts.password.cancel", "Cancel", () => setForm(null), { disabled: busy }),
    },
    rowActions: (account) => {
      if (account.provider !== "password" || !account.email) return [];
      const address = account.email;
      return account.verified
        ? [
          action("accounts.password.change", "Change password", () => openForm("change", account), { disabled: busy }),
          action("accounts.password.reset", "Send reset link", () => void recover("reset", address), { disabled: busy }),
        ]
        : [action("accounts.password.verify", "Resend verification", () => void recover("verify", address), { disabled: busy })];
    },
  };
}
