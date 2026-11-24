import { useCallback, useEffect, useMemo, useState } from "react";

import type { AccessCandidate, AccessInvitation, ApiFailureKind, BackupEntry, BackupInventory, ConfigFileContent, ConfigFileList, ConsoleEntry, HostMetrics, InvitationRecipient, InvitationSummary, LinkedLoginAccounts, MetricRange, ReleaseDiff, ReleaseMod, ReleaseModPage, SavedWhitelist, SubscriptionState, WorldWhitelist } from "../api/contract";
import { ApiError, failureKind } from "../api/contract";
import { useApi, useSignInConfig } from "../api/context";
import type { StatusKind } from "./status";
import { formatBytes, formatDateTime } from "../lib/format";
import { GOOGLE_CLIENT_ID } from "../lib/signin";
import type { Game, Member, OwnerBootstrap, Role, World } from "../model";
import { action, type Action } from "./actions";
import type { Notify } from "./notify";
import type { BackupsModel, CandidateRow, ConfigEditorModel, ConfigFileRow, ConfigFilesModel, ConfirmationModel, InvitationModel, InvitationsModel, Loading, LoginAccountsModel, MetricsModel, ModsModel, ModsPage, NotificationsModel, ReleaseChangesModel, RequestSummary, RoleEditorModel, RolesModel, UsersModel, WhitelistModel } from "./models";
import { releaseChangeRows } from "./release-diff";
import { candidateKey, type AccessDirectory } from "./access-directory";
import { defaultRoleChoice, offeredPermissions, ROLE_ID_PATTERN, roleChoice, roleDeleteRefusal, roleEditRefusal, roleIdFor } from "./roles";
import { FRESH_MODS_VIEW, MOD_SEARCH_DELAY_MS, modListQuery, modSourceEntries, type ModsView } from "./release-mods";
import { type PlayerNameRule, whitelistNameError } from "./whitelist";

/*
 * The data each page loads for itself and what may be done with it. Every
 * hook here returns a model and nothing else; the skin that renders it never
 * touches the API. `notify` is how an outcome reaches the person, whatever
 * the skin draws it as.
 */

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

export function useBackups(gameId: string, world: World, opts: Readonly<{ canRead: boolean; canRestore: boolean; busy: boolean; settled: string; onRestore: (entry: BackupEntry) => void; onDownload: ((entry: BackupEntry) => void) | null }>): BackupsModel {
  const api = useApi();
  const [filter, setFilter] = useState<string | null>(null);
  useEffect(() => { setFilter(null); }, [world.id]);
  const [state, retry] = useLoad<BackupInventory>(opts.canRead ? () => api.loadBackups(gameId, world.id) : null, [opts.canRead, gameId, world.id, opts.settled]);
  const onDownload = opts.onDownload;
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
      hint: restoreHint(world, entry, opts.canRestore),
    }),
    download: onDownload === null ? null : (entry) => action("backup.download", "Download archive", () => onDownload(entry), {
      icon: "download",
      hint: "A link that works for five minutes; the download is recorded against you",
    }),
  };
}

// --- whitelist (ADR-0066) ------------------------------------------------------

/**
 * A world's whitelist, read only while its tab is open. Every change saves the
 * whole list; a running world reloads it at once, a stopped one at its start.
 */
export function useWhitelist(gameId: string, world: World, open: boolean, notify: Notify, playerName: PlayerNameRule | null): WhitelistModel {
  const api = useApi();
  const [state, retry, update] = useLoad<WorldWhitelist>(open ? () => api.loadWhitelist(gameId, world.id) : null, [open, gameId, world.id]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const names = state.status === "ready" ? state.value.names : [];
  const name = draft.trim();
  const draftError = name === "" ? null : whitelistNameError(name, names, playerName);
  const when = (saved: SavedWhitelist) => saved.applied === "reloading" ? "The running server reloads its list now." : `${world.displayName} reads it at its next start.`;
  const save = async (next: readonly string[], said: (saved: SavedWhitelist) => string): Promise<boolean> => {
    setSaving(true);
    try {
      const saved = await api.updateWhitelist(gameId, world.id, next);
      update(() => saved);
      notify({ tone: "success", message: said(saved) });
      return true;
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "The whitelist could not be saved." });
      return false;
    } finally {
      setSaving(false);
    }
  };
  const add = action("whitelist.add", "Add player", () => {
    if (name === "" || draftError !== null) return;
    void save([...names, name], (saved) => `${name} is on the whitelist. ${when(saved)}`).then((saved) => { if (saved) setDraft(""); });
  }, { icon: "add", disabled: state.status !== "ready" || name === "" || draftError !== null || saving, busy: saving });
  const list: WhitelistModel["list"] = state.status !== "ready" ? asLoading(state, retry, "whitelist.retry") : {
    status: "ready",
    value: {
      managed: state.value.managed,
      updatedAt: state.value.updatedAt,
      updatedBy: state.value.updatedBy,
      rows: state.value.names.map((player) => ({
        name: player,
        remove: action(`whitelist.remove.${player}`, "Remove", () => void save(names.filter((item) => item !== player), (saved) => `${player} is off the whitelist. ${when(saved)}`), {
          icon: "close", danger: true, disabled: saving, hint: `Remove ${player} from the whitelist`,
        }),
      })),
    },
  };
  return { world, list, draft, setDraft, draftError, add };
}

// --- config files (ADR-0093) --------------------------------------------------

/**
 * A world's config files, read only while its tab is open. One file opens at a
 * time. A save names the digest the editor loaded, so a change made meanwhile
 * is refused; the world reads its files at its next start.
 */
export function useConfigFiles(gameId: string, world: World, open: boolean, notify: Notify): ConfigFilesModel {
  const api = useApi();
  const [state, retry, updateList] = useLoad<ConfigFileList>(open ? () => api.loadConfigFiles(gameId, world.id) : null, [open, gameId, world.id]);
  const [path, setPath] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [working, setWorking] = useState(false);
  useEffect(() => { setPath(null); setDraft(null); setStale(false); }, [open, gameId, world.id]);
  const [loaded, reloadContent, updateContent] = useLoad<ConfigFileContent>(open && path !== null ? () => api.loadConfigFile(gameId, world.id, path) : null, [open, gameId, world.id, path]);
  // A file's text is its own: the state of the file shown before it is never the new one's.
  const content: LoadState<ConfigFileContent> = loaded.status === "ready" && loaded.value.path !== path ? { status: "loading" } : loaded;

  const refresh = async () => {
    try {
      const fresh = await api.loadConfigFiles(gameId, world.id);
      updateList(() => fresh);
    } catch {
      // The list is shown again from the server when it is opened; a failed refresh keeps the old one.
    }
  };
  const fail = (error: unknown, message: string) => {
    if (error instanceof ApiError && error.code === "config_file_changed") setStale(true);
    notify({ tone: "error", message: error instanceof Error ? error.message : message });
  };
  const when = `${world.displayName} reads it at its next start.`;
  const close = () => { setPath(null); setDraft(null); setStale(false); };
  const row = state.status === "ready" && path !== null ? state.value.files.find((file) => file.path === path) : undefined;

  const rows: readonly ConfigFileRow[] = state.status === "ready"
    ? [...state.value.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({
      path: file.path,
      bytes: file.bytes,
      edited: file.source !== "release",
      added: file.source === "world_only",
      releaseChanged: file.releaseChanged,
      updatedAt: file.updatedAt,
      updatedBy: file.updatedBy,
      open: action(`config.open.${file.path}`, "Edit", () => { setPath(file.path); setDraft(null); setStale(false); }, {
        icon: "edit",
        disabled: !file.editable,
        hint: file.editable ? `Edit ${file.path}` : `${formatBytes(file.bytes)}: not text, or too large to edit here`,
      }),
    }))
    : [];

  const text = draft ?? (content.status === "ready" ? content.value.text : "");
  const dirty = content.status === "ready" && draft !== null && draft !== content.value.text;
  const shown: ConfigEditorModel["content"] = content.status === "ready" ? { status: "ready", value: null }
    : content.status === "loading" ? content
      : { status: "error", error: content.error, kind: content.kind, retry: action("config.retry", "Try again", reloadContent) };
  const editor: ConfigEditorModel | null = path === null ? null : {
    path,
    content: shown,
    text,
    setText: setDraft,
    dirty,
    save: action("config.save", "Save", () => {
      if (content.status !== "ready" || !dirty || draft === null) return;
      setWorking(true);
      void api.saveConfigFile(gameId, world.id, path, draft, content.value.sha256)
        .then(async (saved) => {
          updateContent((current) => ({ ...current, text: draft, sha256: saved.sha256 }));
          setDraft(null);
          notify({ tone: "success", message: `${path} is saved. ${when}` });
          await refresh();
        })
        .catch((error: unknown) => fail(error, "The file could not be saved."))
        .finally(() => setWorking(false));
    }, { icon: "check", disabled: content.status !== "ready" || !dirty || stale || working, busy: working, hint: dirty ? undefined : "Nothing to save" }),
    reset: row?.source === "world" ? action("config.reset", "Reset to release", () => {
      setWorking(true);
      void api.resetConfigFile(gameId, world.id, path, row.worldSha256)
        .then(async () => {
          setDraft(null);
          setStale(false);
          notify({ tone: "success", message: `${path} is the release's file again. ${when}` });
          reloadContent();
          await refresh();
        })
        .catch((error: unknown) => fail(error, "The file could not be reset."))
        .finally(() => setWorking(false));
    }, { icon: "restore", disabled: working, hint: "Drop this world's version and use the release's file" }) : null,
    reload: stale ? action("config.reload", "Reload", () => { setDraft(null); setStale(false); reloadContent(); void refresh(); }, { icon: "refresh" }) : null,
    close: action("config.close", "Close", close, { icon: "close" }),
  };
  const list: ConfigFilesModel["list"] = state.status !== "ready" ? asLoading(state, retry, "config.list.retry") : { status: "ready", value: { release: state.value.release, rows } };
  return { world, list, editor };
}

// --- release files (ADR-0065) -------------------------------------------------

function modsPending(state: Exclude<LoadState<ReleaseModPage>, { status: "ready" }>, retry: () => void): Loading<ModsPage> {
  return state.status === "error" ? { status: "error", error: state.error, kind: state.kind, retry: action("mods.retry", "Try again", retry) } : state;
}

type ModsState = Readonly<{ key: string; view: ModsView }>;

/**
 * A release's mods of both sides, read only while the tab that shows them is
 * open (ADR-0065, ADR-0069), one page at a time. The server searches, filters,
 * sorts and pages; the search waits for a pause in typing, and any other choice
 * returns to page 1. What a person chose stays while pages load and while the
 * tab is closed, and starts again for another release.
 */
export function useReleaseMods(gameId: string, release: Readonly<{ presetId: string; version: string }> | null, onDownload: (presetId: string, version: string, mod: ReleaseMod) => void): ModsModel | null {
  const api = useApi();
  const key = release === null ? "" : `${gameId}/${release.presetId}/${release.version}`;
  const [kept, setKept] = useState<ModsState>({ key, view: FRESH_MODS_VIEW });
  const view = kept.key === key ? kept.view : FRESH_MODS_VIEW;
  const change = useCallback((patch: Partial<ModsView>) => setKept((current) => ({ key, view: { ...(current.key === key ? current.view : FRESH_MODS_VIEW), ...patch } })), [key]);
  useEffect(() => {
    if (view.search === view.applied) return;
    const timer = window.setTimeout(() => change({ applied: view.search, page: 1 }), MOD_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [view.search, view.applied, change]);

  const query = modListQuery(view);
  const [state, retry] = useLoad<ReleaseModPage>(release === null ? null : () => api.loadReleaseMods(gameId, release.presetId, release.version, query), [key, query.search, query.source, query.sort, query.order, query.page]);
  const [held, setHeld] = useState<Readonly<{ key: string; split: boolean; pages: number; sources: ReleaseModPage["sources"] }> | null>(null);
  useEffect(() => {
    if (state.status === "ready") setHeld({ key, split: state.value.split, pages: state.value.pages, sources: state.value.sources });
  }, [state, key]);
  if (release === null) return null;

  const ready = state.status === "ready" ? state.value : null;
  const facts = held?.key === key ? held : null;
  const narrowed = view.applied.trim() !== "" || view.source !== null;
  const files: Loading<ModsPage> = state.status !== "ready" ? modsPending(state, retry) : {
    status: "ready",
    value: {
      total: state.value.total,
      all: state.value.all,
      rows: state.value.mods.map((mod) => ({
        ...mod,
        source: mod.source ?? null,
        download: action(`mod.download.${mod.sha256}`, "Download", () => onDownload(release.presetId, release.version, mod), { icon: "download" }),
      })),
    },
  };
  return {
    release: release.version,
    split: ready?.split ?? facts?.split ?? false,
    search: view.search,
    setSearch: (value) => change({ search: value }),
    source: view.source,
    setSource: (source) => change({ source, page: 1 }),
    sources: modSourceEntries(ready?.sources ?? facts?.sources ?? []),
    sort: view.sort,
    setSort: (sortKey, direction) => change({ sort: { key: sortKey, direction }, page: 1 }),
    page: ready?.page ?? view.page,
    pages: ready?.pages ?? facts?.pages ?? 1,
    setPage: (page) => change({ page }),
    narrowed,
    clear: () => change({ search: "", applied: "", source: null, page: 1 }),
    files,
  };
}

/**
 * What a release changes (P3), read only while the Releases tab is open:
 * against `from` while a promotion waits, otherwise against what its build compared.
 */
export function useReleaseChanges(gameId: string, release: Readonly<{ presetId: string; version: string; from: string | null }> | null): ReleaseChangesModel | null {
  const api = useApi();
  const [state, retry] = useLoad<ReleaseDiff | null>(release === null ? null : () => api.loadReleaseDiff(gameId, release.presetId, release.version, release.from), [gameId, release?.presetId, release?.version, release?.from]);
  if (release === null) return null;
  if (state.status !== "ready") return { release: release.version, changes: asLoading(state, retry, "changes.retry") };
  const diff = state.value;
  return { release: release.version, changes: { status: "ready", value: diff === null ? null : { from: diff.from, ...releaseChangeRows(diff) } } };
}

function restoreHint(world: World, entry: BackupEntry, canRestore: boolean): string {
  if (!world.worldLifecycleAvailable) return "This legacy world is not wipe-managed.";
  if (entry.generationId === null) return "This legacy backup is not tied to a wipe.";
  return canRestore ? "Restore into a new wipe" : "Your role cannot restore backups.";
}

// --- metrics -----------------------------------------------------------------

export const METRIC_RANGES: readonly { id: MetricRange; label: string }[] = [
  { id: "6h", label: "6 hours" },
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
];

/** The host one world runs on, measured; read only while the tab is open, and again when its session starts or ends. */
export function useWorldMetrics(gameId: string | undefined, worldId: string | undefined, sessionId: string | null): MetricsModel {
  const api = useApi();
  const [range, setRange] = useState<MetricRange>("24h");
  const [state, retry] = useLoad<HostMetrics | null>(gameId === undefined || worldId === undefined ? null : () => api.loadWorldMetrics(gameId, worldId, range), [gameId, worldId, range, sessionId]);
  return { range, ranges: METRIC_RANGES, setRange, metrics: asLoading(state, retry, "metrics.retry") };
}

// --- console (ADR-0063) --------------------------------------------------------

const CONSOLE_POLL_PENDING_MS = 1500;
const CONSOLE_POLL_IDLE_MS = 5000;

export type ConsoleGateway = Readonly<{
  entries: LoadState<readonly ConsoleEntry[]>;
  sending: boolean;
  /** Resolves true when the command was accepted; a refusal reaches `notify`. */
  run: (command: string) => Promise<boolean>;
  retry: () => void;
}>;

/**
 * A world's console history, kept fresh without flicker: the first read shows
 * as loading, later reads replace the list in place. A command that waits for
 * its answer is read again sooner than a quiet log.
 */
export function useConsoleGateway(gameId: string | undefined, worldId: string | undefined, notify: Notify): ConsoleGateway {
  const api = useApi();
  const [entries, setEntries] = useState<LoadState<readonly ConsoleEntry[]>>({ status: "loading" });
  const [sending, setSending] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (gameId === undefined || worldId === undefined) return;
    let current = true;
    setEntries({ status: "loading" });
    api.loadConsole(gameId, worldId)
      .then((value) => { if (current) setEntries({ status: "ready", value }); })
      .catch((cause: unknown) => { if (current) setEntries({ status: "error", error: cause instanceof Error ? cause.message : "The console history could not be loaded.", kind: failureKind(cause) }); });
    return () => { current = false; };
  }, [gameId, worldId, revision]);

  const pending = entries.status === "ready" && entries.value.some((entry) => entry.status === "pending");
  useEffect(() => {
    if (gameId === undefined || worldId === undefined || entries.status !== "ready") return;
    let current = true;
    const timer = window.setTimeout(() => {
      api.loadConsole(gameId, worldId)
        .then((value) => { if (current) setEntries({ status: "ready", value }); })
        .catch(() => undefined);
    }, pending ? CONSOLE_POLL_PENDING_MS : CONSOLE_POLL_IDLE_MS);
    return () => { current = false; window.clearTimeout(timer); };
  }, [gameId, worldId, entries, pending]);

  const run = useCallback(async (command: string) => {
    if (gameId === undefined || worldId === undefined) return false;
    setSending(true);
    try {
      const entry = await api.runConsoleCommand(gameId, worldId, command);
      setEntries((state) => state.status === "ready" ? { status: "ready", value: [entry, ...state.value.filter((item) => item.id !== entry.id)] } : state);
      return true;
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "The command could not be sent." });
      return false;
    } finally {
      setSending(false);
    }
  }, [gameId, worldId, notify]);

  return { entries, sending, run, retry: () => setRevision((value) => value + 1) };
}

// --- access: users -------------------------------------------------------------

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

/**
 * The people waiting for access (asked, or signed in and not approved), for a page that shows them beside other
 * things (the console skin's game home). They are the directory's candidates, so the count and the Access page
 * agree. Approve sends no role, so the API gives the default one; the Access page is where another is chosen.
 */
export function accessRequests(directory: AccessDirectory): Readonly<{
  requests: Loading<readonly RequestSummary[]> | null;
  actions: (id: string) => Readonly<{ approve: Action; dismiss: Action }> | null;
}> {
  const { candidates, working } = directory;
  const open = candidates.status === "ready" ? candidates.value : [];
  return {
    requests: candidates.status !== "ready" ? candidates : {
      status: "ready",
      value: open.map((candidate) => ({ id: candidateKey(candidate), displayName: candidate.displayName, platform: candidate.platform, account: candidateAccount(candidate), since: candidate.requestedAt ?? candidate.lastSeenAt, photoUrl: candidate.photoUrl })),
    },
    actions: (id) => {
      const candidate = open.find((item) => candidateKey(item) === id);
      if (!candidate) return null;
      return {
        approve: action("access.approve", "Approve", () => void directory.approve(candidate), { icon: "check", disabled: working !== null, busy: working === id, hint: "Approve with the default role" }),
        dismiss: action("access.dismiss", "Dismiss", () => void directory.dismiss(candidate), { icon: "close", disabled: working !== null }),
      };
    },
  };
}

/** Delete is reachable where the API says the caller may delete this identity. */
export function memberRemoval(member: Member, open: (member: Member) => void): Action | null {
  if (!member.canDelete) return null;
  return action("access.delete", "Delete user", () => open(member), { danger: true, icon: "delete_forever" });
}

export function deletionConfirmation(member: Member, opts: Readonly<{ typed: string; setTyped: (value: string) => void; busy: boolean; error: string | null; confirm: () => void; cancel: () => void }>): ConfirmationModel {
  const expected = member.name.trim();
  return {
    title: `Delete ${expected}?`,
    description: "Removes their sign-in methods, sessions and agent connections. This cannot be undone.",
    destructive: true,
    confirm: action("access.delete.confirm", "Delete user", opts.confirm, { danger: true, disabled: opts.busy || opts.typed.trim() !== expected, busy: opts.busy }),
    cancel: action("access.delete.cancel", "Cancel", opts.cancel, { disabled: opts.busy }),
    releaseChoice: null,
    typedConfirmation: { label: "User name", expected, value: opts.typed, set: opts.setTyped },
    error: opts.error,
  };
}

/**
 * Deletes one person; on success the row goes and the panel showing them
 * closes. A refusal changes nothing and is returned for the open dialog,
 * which keeps it in view until the next attempt.
 */
export async function deleteMember(member: Member, deps: Readonly<{ remove: (identityId: string) => Promise<void>; members: readonly Member[]; onMembersChange: (members: Member[]) => void; managing: string | null; closeManaged: () => void; notify: Notify }>): Promise<string | null> {
  try {
    await deps.remove(member.id);
  } catch (cause) {
    return cause instanceof Error ? cause.message : "This user could not be deleted.";
  }
  deps.onMembersChange(deps.members.filter((item) => item.id !== member.id));
  if (deps.managing === member.id) deps.closeManaged();
  deps.notify({ tone: "success", message: `${member.name.trim()} was deleted.` });
  return null;
}

export function useUsers(opts: Readonly<{ bootstrap: OwnerBootstrap; canInvite: boolean; directory: AccessDirectory; notify: Notify }>): UsersModel {
  const api = useApi();
  const { directory, notify } = opts;
  const { members, candidates: waiting, working } = directory;
  const { roles, defaultRoleId } = directory.roles;
  const [managing, setManaging] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [removing, setRemoving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [candidateRoles, setCandidateRoles] = useState<Record<string, string>>({});
  const invitations = useInvitations(opts.canInvite, notify);

  function openDeletion(member: Member) {
    setTyped("");
    setRefusal(null);
    setDeleting(member.id);
  }

  async function confirmDeletion(member: Member) {
    setRemoving(true);
    setRefusal(null);
    const refused = await deleteMember(member, { remove: api.deleteIdentity, members, onMembersChange: directory.setMembers, managing, closeManaged: () => setManaging(null), notify });
    setRemoving(false);
    if (refused === null) setDeleting(null);
    else setRefusal(refused);
  }

  const rolesReady = roles.length > 0 && defaultRoleId !== null;
  const target = members.find((member) => member.id === deleting) ?? null;
  const candidates: Loading<readonly CandidateRow[]> = waiting.status !== "ready"
    ? waiting
    : {
      status: "ready",
      value: waiting.value.map((candidate) => {
        const key = candidateKey(candidate);
        const chosen = candidateRoles[key] ?? defaultRoleId;
        return {
          id: key,
          candidate,
          account: candidateAccount(candidate),
          since: `${candidate.status === "REQUESTED" ? "Requested access" : "Signed in"} ${formatDateTime(candidate.status === "REQUESTED" ? candidate.requestedAt : candidate.lastSeenAt)}`,
          role: roleChoice(roles, chosen ?? "", working === key),
          setRoleId: (roleId: string) => setCandidateRoles((current) => ({ ...current, [key]: roleId })),
          approve: action("access.approve", "Approve", () => { if (chosen !== null) void directory.approve(candidate, chosen); }, { disabled: !rolesReady, busy: working === key, hint: rolesReady ? "Approve with the chosen role" : "Roles are still loading" }),
          dismiss: action("access.dismiss", "Dismiss", () => void directory.dismiss(candidate), { disabled: working === key }),
        };
      }),
    };

  return {
    bootstrap: opts.bootstrap,
    bootstrapDescription: bootstrapDescription(opts.bootstrap),
    candidates,
    members: members.map((member) => ({
      member,
      role: roleChoice(roles, member.roleId, working === member.id),
      setRoleId: (roleId: string) => void directory.changeRole(member, roleId),
      changing: working === member.id,
      linkedAccounts: action("access.linked", "Linked accounts", () => setManaging(member.id), { icon: "link" }),
      remove: memberRemoval(member, openDeletion),
    })),
    roles,
    invitations,
    managed: members.find((member) => member.id === managing) ?? null,
    closeManaged: action("sheet.close", "Close panel", () => setManaging(null)),
    deletion: target === null ? null : deletionConfirmation(target, { typed, setTyped, busy: removing, error: refusal, confirm: () => void confirmDeletion(target), cancel: () => setDeleting(null) }),
  };
}

// --- access: invitations to the project -------------------------------------------

function useInvitations(enabled: boolean, notify: Notify): InvitationsModel | null {
  const api = useApi();
  const [email, setEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ url: string; id: string; email: string } | null>(null);
  const [emailMode, setEmailMode] = useState<boolean | null>(null);
  const [state, retry] = useLoad<AccessInvitation[]>(enabled ? () => api.loadAccessInvitations() : null, [enabled]);
  useEffect(() => { if (enabled) void api.loadLoginOptions().then((options) => setEmailMode(options.emailActions)); }, [enabled]);
  if (!enabled) return null;

  async function create() {
    setCreating(true);
    setIssued(null);
    try {
      const recipient = emailMode ? email.trim() : null;
      const result = await api.createAccessInvitation(recipient);
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
      await api.revokeAccessInvitation(invitation.id);
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

/** Edit is offered where the API says `editable`; a refused one says why. */
export function roleEditAction(role: Role, run: () => void): Action {
  const reason = roleEditRefusal(role);
  return action("access.role.edit", "Edit", run, { icon: "edit", disabled: reason !== null, hint: reason ?? undefined });
}

/** Delete is offered where the API says `deletable`; a refused one says why. */
export function roleRemoveAction(role: Role, defaultRoleId: string | null, run: () => void): Action {
  const reason = roleDeleteRefusal(role, defaultRoleId);
  return action("access.role.delete", "Delete", run, { danger: true, icon: "delete_forever", disabled: reason !== null, hint: reason ?? undefined });
}

type RoleForm = Readonly<{ mode: "create" } | { mode: "edit"; roleId: string; version: number }>;

const sameSet = (a: ReadonlySet<string>, b: readonly string[]) => a.size === b.length && b.every((item) => a.has(item));

export function useRoles(opts: Readonly<{ directory: AccessDirectory; granted: ReadonlySet<string>; notify: Notify }>): RolesModel {
  const api = useApi();
  const { granted, notify } = opts;
  const directory = opts.directory.roles;
  const state = opts.directory.rolesState;
  const [reading, setReading] = useState<string | null>(null);
  const [form, setForm] = useState<RoleForm | null>(null);
  const [draft, setDraft] = useState({ id: "", idTouched: false, name: "", description: "", permissions: new Set<string>() });
  const [deleting, setDeleting] = useState<Readonly<{ roleId: string; version: number }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const roles = state.status === "ready" ? state.value : [];
  const canManage = granted.has("access.manage");
  const why = canManage ? undefined : "Your role cannot manage access.";

  // Holders and versions change under a write, so the directory reads the roles again, quietly.
  const refresh = opts.directory.refreshRoles;

  // A write refused as out of date closes its form: the role is read again and the person reopens it.
  async function refused(cause: unknown, fallback: string): Promise<string | null> {
    if (cause instanceof ApiError && cause.code === "role_changed") {
      setForm(null);
      setDeleting(null);
      notify({ tone: "error", message: "Someone changed this role. The list is reloaded." });
      await refresh();
      return null;
    }
    return cause instanceof Error ? cause.message : fallback;
  }

  function open(next: RoleForm, from: { id: string; name: string; description: string; permissions: readonly string[] }) {
    setRefusal(null);
    setDraft({ id: from.id, idTouched: from.id !== "", name: from.name, description: from.description, permissions: new Set(from.permissions) });
    setForm(next);
  }

  async function submit(current: RoleForm) {
    const body = { name: draft.name.trim(), description: draft.description.trim(), permissions: [...draft.permissions] };
    setBusy(true);
    setRefusal(null);
    try {
      const saved = current.mode === "create" ? await api.createAccessRole(draft.id, body) : await api.updateAccessRole(current.roleId, body, current.version);
      setForm(null);
      notify({ message: current.mode === "create" ? `${saved.name} created.` : `${saved.name} saved.` });
      await refresh();
    } catch (cause) {
      setRefusal(await refused(cause, current.mode === "create" ? "The role could not be created." : "The role could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeletion(role: Role, version: number) {
    setBusy(true);
    setRefusal(null);
    try {
      await api.deleteAccessRole(role.id, version);
      setDeleting(null);
      notify({ message: `${role.name} deleted.` });
      await refresh();
    } catch (cause) {
      setRefusal(await refused(cause, "The role could not be deleted."));
    } finally {
      setBusy(false);
    }
  }

  async function chooseDefault(roleId: string) {
    setBusy(true);
    try {
      await api.updateDefaultRole(roleId);
      notify({ message: `New people now get ${roles.find((role) => role.id === roleId)?.name ?? roleId}.` });
      await refresh();
    } catch (cause) {
      notify({ tone: "error", message: cause instanceof Error ? cause.message : "The default role could not be changed." });
    } finally {
      setBusy(false);
    }
  }

  const editing = form?.mode === "edit" ? roles.find((role) => role.id === form.roleId) : undefined;
  const idError = form?.mode === "create" && draft.id !== "" && !ROLE_ID_PATTERN.test(draft.id) ? "Use a lower-case letter first, then letters, digits or hyphens (up to 32)." : null;
  const valid = draft.name.trim() !== "" && (form?.mode !== "create" || ROLE_ID_PATTERN.test(draft.id));
  const changed = form?.mode !== "edit" || !editing || draft.name.trim() !== editing.name || draft.description.trim() !== editing.description || !sameSet(draft.permissions, editing.permissions);
  const removing = deleting === null ? undefined : roles.find((role) => role.id === deleting.roleId);

  const editor: RoleEditorModel | null = form === null || (form.mode === "edit" && !editing) ? null : {
    mode: form.mode,
    title: form.mode === "create" ? "New role" : `Edit ${editing!.name}`,
    id: draft.id,
    setId: (value) => setDraft((current) => ({ ...current, id: value, idTouched: true })),
    idError,
    name: draft.name,
    setName: (value) => setDraft((current) => ({ ...current, name: value, id: current.idTouched ? current.id : roleIdFor(value) })),
    description: draft.description,
    setDescription: (value) => setDraft((current) => ({ ...current, description: value })),
    permissions: offeredPermissions(directory.permissions, granted).map(({ permission, locked }) => {
      const checked = draft.permissions.has(permission.id);
      return {
        permission,
        checked,
        toggle: action(`access.role.permission.${permission.id}`, permission.label, () => setDraft((current) => {
          const next = new Set(current.permissions);
          if (checked) next.delete(permission.id);
          else next.add(permission.id);
          return { ...current, permissions: next };
        }), { disabled: locked || busy, hint: locked ? "You do not hold this permission." : undefined }),
      };
    }),
    error: refusal,
    submit: action("access.role.save", form.mode === "create" ? "Create role" : "Save role", () => void submit(form), { disabled: busy || !valid || idError !== null || !changed, busy }),
    cancel: action("access.role.cancel", "Cancel", () => setForm(null), { disabled: busy }),
  };

  const deletion: ConfirmationModel | null = deleting === null || !removing ? null : {
    title: `Delete ${removing.name}?`,
    description: "Removes this role. This cannot be undone.",
    destructive: true,
    confirm: action("access.role.delete.confirm", "Delete role", () => void confirmDeletion(removing, deleting.version), { danger: true, disabled: busy, busy }),
    cancel: action("access.role.delete.cancel", "Cancel", () => setDeleting(null), { disabled: busy }),
    releaseChoice: null,
    typedConfirmation: null,
    error: refusal,
  };

  return {
    roles: state,
    reading: roles.find((item) => item.id === reading) ?? null,
    read: (role) => action("access.role.read", `${role.permissions.length} ${role.permissions.length === 1 ? "permission" : "permissions"}`, () => setReading(role.id), { icon: "chevron_right" }),
    closeReading: action("sheet.close", "Close panel", () => setReading(null)),
    create: action("access.role.create", "New role", () => open({ mode: "create" }, { id: "", name: "", description: "", permissions: [] }), { icon: "add", disabled: !canManage, hint: why }),
    edit: (role) => roleEditAction(role, () => { setReading(null); open({ mode: "edit", roleId: role.id, version: role.version }, role); }),
    remove: (role) => roleRemoveAction(role, directory.defaultRoleId, () => { setReading(null); setRefusal(null); setDeleting({ roleId: role.id, version: role.version }); }),
    editor,
    deletion,
    defaultRole: { choice: defaultRoleChoice(roles, directory.defaultRoleId, busy || !canManage), set: (roleId) => void chooseDefault(roleId) },
  };
}

// --- access: notifications ------------------------------------------------------

function saveStatusLabel(state: "loading" | "ready" | "saving" | "error"): string {
  if (state === "saving") return "Saving…";
  return state === "ready" ? "Saved to your identity" : "";
}

export function useNotifications(games: readonly Game[], notify: Notify): NotificationsModel {
  const api = useApi();
  const [subscriptions, setSubscriptions] = useState<SubscriptionState>({});
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      setSubscriptions(await api.loadSubscriptions());
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
      setSubscriptions(await api.updateSubscriptions(next));
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
    saveStatus: saveStatusLabel(state),
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

function players(count: number): string {
  return `${count} ${count === 1 ? "player" : "players"}`;
}

function sendHint(audience: "broadcast" | "direct", selected: number): string {
  if (audience === "broadcast") return "One Telegram message to group chats and subscribers.";
  return selected === 0 ? "Choose at least one player." : `${players(selected)} selected.`;
}

export function useInvitation(game: Game, world: World, opts: Readonly<{ onClose: () => void; notify: Notify }>): InvitationModel {
  const api = useApi();
  const [audience, setAudience] = useState<"broadcast" | "direct">("broadcast");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState(false);
  const [recipientState, retryRecipients] = useLoad<InvitationRecipient[]>(() => api.loadInvitationRecipients(), [game.id, world.id]);
  const [historyState, refreshHistory] = useLoad<InvitationSummary[]>(() => api.loadInvitationHistory(game.id, world.id), [game.id, world.id]);
  const recipients = recipientState.status === "ready" ? recipientState.value : [];
  const needle = query.trim().toLocaleLowerCase();

  function toggle(recipient: InvitationRecipient) {
    if (recipient.delivery !== "ready") return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(recipient.id)) {
        next.delete(recipient.id);
      } else {
        next.add(recipient.id);
      }
      return next;
    });
  }

  async function submit() {
    setSending(true);
    try {
      await api.sendInvitation(game.id, world.id, audience, [...selected]);
      opts.notify({ tone: "success", message: audience === "broadcast" ? "Invitation accepted for delivery to everyone." : `Invitation accepted for ${players(selected.size)}.` });
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
    send: action("invitation.send", "Send invitation", () => void submit(), { icon: "send", busy: sending, disabled: sending || (audience === "direct" && selected.size === 0), hint: sendHint(audience, selected.size) }),
    close: action("sheet.close", "Close panel", opts.onClose),
  };
}

// --- profile: sign-in methods -------------------------------------------------------

export function useLoginAccounts(displayName: string, notify: Notify): LoginAccountsModel {
  const api = useApi();
  const signIn = useSignInConfig();
  const [state, retry] = useLoad<LinkedLoginAccounts>(() => api.loadLinkedAccounts(), []);
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
        await api.linkPassword(email, password, displayName);
        notify({ tone: "success", message: `A verification link was sent to ${email}.` });
      } else {
        await api.changePassword(email, currentPassword, password);
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
      if (kind === "verify") await api.resendEmailVerification(address); else await api.requestPasswordReset(address);
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
    connectTelegram: ready !== null && !has("telegram") && linkable.includes("telegram") && /^[1-9]\d+$/.test(signIn.telegramClientId) ? (idToken) => connect(api.linkTelegram, "Telegram", idToken) : null,
    connectGoogle: ready !== null && !has("google") && linkable.includes("google") && GOOGLE_CLIENT_ID.test(signIn.googleClientId) ? (idToken) => connect(api.linkGoogle, "Google", idToken) : null,
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
