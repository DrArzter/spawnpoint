import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { failureKind, type AccessCandidate, type AccessIdentity, type AccessRoleDirectory, type ActiveSession, type ApiFailureKind, type SpawnpointApi } from "../api/contract";
import { useApi } from "../api/context";
import type { LinkKind, Member, Role } from "../model";
import { action } from "./actions";
import type { Notify } from "./notify";
import type { Loading } from "./models";
import type { RoleDirectory } from "./roles";
import { t } from "../i18n";

/*
 * The access directory: who has access, who is waiting, and the roles. One
 * store owns it for the whole console, so the rail's request count, the game
 * home and the Access page read the same answer, and a decision made on one is
 * seen on the others at once. It holds data and the three decisions that change
 * it (approve, dismiss, change a role). What a person is asked before deleting,
 * and which form is open, stay with the page that draws them.
 */

/** The one key of a waiting account: its platform and its id on that platform. Two platforms may share an id. */
export const candidateKey = (candidate: Readonly<{ platform: string; platformUserId: string }>) => `${candidate.platform}:${candidate.platformUserId}`;

const linkKinds: readonly LinkKind[] = ["telegram", "email", "google", "discord", "minecraft", "factorio", "steam", "zerotier"];

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

export function memberOf(identity: AccessIdentity): Member {
  return {
    id: identity.id,
    name: identity.displayName,
    roleId: identity.roleId,
    canDelete: identity.canDelete,
    photoUrl: identity.photoUrl ?? null,
    links: identity.links.flatMap((link) => { const mapped = linkFor(link.platform, link.value, link.handle, link.verified); return mapped === null ? [] : [mapped]; }),
  };
}

export type Remote<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; error: string; kind: ApiFailureKind };

type People = Readonly<{ candidates: readonly AccessCandidate[]; members: readonly Member[] }>;

export type DirectoryState = Readonly<{
  people: Remote<People>;
  roles: Remote<AccessRoleDirectory>;
  /** The candidate key or the identity id that a decision is running for. */
  working: string | null;
}>;

/** What the directory calls; the console gives it the API, a test gives it a fake. */
export type DirectoryApi = Readonly<{
  loadCandidates: () => Promise<AccessCandidate[]>;
  loadIdentities: () => Promise<AccessIdentity[]>;
  loadRoles: () => Promise<AccessRoleDirectory>;
  approve: (platform: string, platformUserId: string, roleId?: string) => Promise<{ id: string; displayName: string; roleId: string }>;
  dismiss: (platform: string, platformUserId: string) => Promise<void>;
  changeRole: (identityId: string, roleId: string) => Promise<void>;
}>;

/** The directory's calls, on the port. */
const directoryApi = (api: SpawnpointApi): DirectoryApi => ({
  loadCandidates: () => api.loadAccessCandidates(),
  loadIdentities: () => api.loadAccessIdentities(),
  loadRoles: () => api.loadAccessRoles(),
  approve: (platform, platformUserId, roleId) => api.approveAccessCandidate(platform, platformUserId, roleId),
  dismiss: (platform, platformUserId) => api.dismissAccessCandidate(platform, platformUserId),
  changeRole: (identityId, roleId) => api.updateIdentityRole(identityId, roleId),
});

const failed = (cause: unknown): Remote<never> => ({ status: "error", error: cause instanceof Error ? cause.message : t("common.requestFailed"), kind: failureKind(cause) });

export class AccessDirectoryStore {
  private state: DirectoryState = { people: { status: "loading" }, roles: { status: "loading" }, working: null };
  private readonly listeners = new Set<() => void>();
  // A change a decision makes supersedes every read still in flight, so an older answer never puts back what it removed.
  private peopleTicket = 0;
  private rolesTicket = 0;

  constructor(private readonly api: DirectoryApi, private readonly notify: Notify) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly snapshot = () => this.state;

  private set(patch: Partial<DirectoryState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** A silent read keeps what is shown while it runs, and keeps it if it fails. */
  async readPeople(silent: boolean): Promise<void> {
    const ticket = ++this.peopleTicket;
    if (!silent) this.set({ people: { status: "loading" } });
    try {
      const [candidates, identities] = await Promise.all([this.api.loadCandidates(), this.api.loadIdentities()]);
      if (ticket === this.peopleTicket) this.set({ people: { status: "ready", value: { candidates, members: identities.map(memberOf) } } });
    } catch (cause) {
      if (ticket === this.peopleTicket && !(silent && this.state.people.status === "ready")) this.set({ people: failed(cause) });
    }
  }

  async readRoles(silent: boolean): Promise<void> {
    const ticket = ++this.rolesTicket;
    if (!silent) this.set({ roles: { status: "loading" } });
    try {
      const value = await this.api.loadRoles();
      if (ticket === this.rolesTicket) this.set({ roles: { status: "ready", value } });
    } catch (cause) {
      if (ticket === this.rolesTicket && !(silent && this.state.roles.status === "ready")) this.set({ roles: failed(cause) });
    }
  }

  private changePeople(update: (people: People) => People) {
    this.peopleTicket += 1;
    const { people } = this.state;
    if (people.status === "ready") this.set({ people: { status: "ready", value: update(people.value) } });
  }

  setMembers(members: readonly Member[]) {
    this.changePeople((people) => ({ ...people, members }));
  }

  private roleName(roleId: string): string {
    const served = this.state.roles;
    return (served.status === "ready" ? served.value.roles.find((role) => role.id === roleId)?.name : undefined) ?? roleId;
  }

  private async decide(key: string, run: () => Promise<void>, failure: string) {
    this.set({ working: key });
    try {
      await run();
    } catch (cause) {
      this.notify({ tone: "error", message: cause instanceof Error ? cause.message : failure });
    } finally {
      this.set({ working: null });
    }
  }

  private withoutCandidate(candidate: AccessCandidate) {
    this.changePeople((people) => ({ ...people, candidates: people.candidates.filter((item) => candidateKey(item) !== candidateKey(candidate)) }));
  }

  /** Without a role, the API gives the default one. */
  approve(candidate: AccessCandidate, roleId?: string): Promise<void> {
    return this.decide(candidateKey(candidate), async () => {
      const identity = await this.api.approve(candidate.platform, candidate.platformUserId, roleId);
      this.withoutCandidate(candidate);
      this.notify({ tone: "success", message: roleId === undefined ? t("access.identityDisplayNameApproved", { identityDisplayName: identity.displayName }) : t("access.identityDisplayNameApprovedAsRoleName", { identityDisplayName: identity.displayName, roleName: this.roleName(identity.roleId) }) });
      // Who may be deleted follows the roles held, so the people are read again after a decision.
      void this.readPeople(true);
    }, t("access.accountCouldNotApproved"));
  }

  dismiss(candidate: AccessCandidate): Promise<void> {
    return this.decide(candidateKey(candidate), async () => {
      await this.api.dismiss(candidate.platform, candidate.platformUserId);
      this.withoutCandidate(candidate);
      this.notify({ message: t("access.candidateDisplayNameDismissed", { candidateDisplayName: candidate.displayName }) });
    }, t("access.accountCouldNotDismissed"));
  }

  changeRole(member: Member, roleId: string): Promise<void> {
    return this.decide(member.id, async () => {
      await this.api.changeRole(member.id, roleId);
      this.changePeople((people) => ({ ...people, members: people.members.map((item) => (item.id === member.id ? { ...item, roleId } : item)) }));
      this.notify({ tone: "success", message: t("access.memberNameNowRoleName", { memberName: member.name, roleName: this.roleName(roleId) }) });
      void this.readPeople(true);
    }, t("access.roleCouldNotChanged"));
  }
}

export type AccessDirectory = Readonly<{
  /** Accounts waiting for a decision; a refusal, where the caller may not read them. */
  candidates: Loading<readonly AccessCandidate[]>;
  /** The identities, or the signed-in one alone until they are read (or where the caller may not read them). */
  members: readonly Member[];
  setMembers: (members: Member[]) => void;
  /** The role list as served; the signed-in role alone until it is read. */
  roles: RoleDirectory;
  rolesState: Loading<readonly Role[]>;
  /** What the rail's badge counts: null until the list is read, and where the caller may not read it. */
  requestCount: number | null;
  working: string | null;
  /** Reads the roles again without clearing them, as after a role write. */
  refreshRoles: () => Promise<void>;
  /** Reads the people again without clearing them; a page calls it as it opens. */
  refresh: () => void;
  /** Without a role, the API gives the default one. */
  approve: (candidate: AccessCandidate, roleId?: string) => Promise<void>;
  dismiss: (candidate: AccessCandidate) => Promise<void>;
  changeRole: (member: Member, roleId: string) => Promise<void>;
}>;

type Reading = Readonly<{ self: Member; ownRole: ActiveSession["role"]; canManage: boolean }>;

/** What a page reads of the state: the same values for every page, whatever it draws. */
export function readDirectory(state: DirectoryState, reading: Reading, retry: Readonly<{ people: () => void; roles: () => void }>): Pick<AccessDirectory, "candidates" | "members" | "roles" | "rolesState" | "requestCount" | "working"> {
  const { people, roles: served } = state;
  const { self, ownRole, canManage } = reading;
  let candidates: Loading<readonly AccessCandidate[]> = { status: "loading" };
  if (!canManage) candidates = { status: "error", error: t("access.roleCannotReadAccess"), kind: "forbidden", retry: action("access.candidates.retry", t("common.tryAgain"), () => undefined) };
  else if (people.status === "error") candidates = { status: "error", error: people.error, kind: people.kind, retry: action("access.candidates.retry", t("common.tryAgain"), retry.people) };
  else if (people.status === "ready") candidates = { status: "ready", value: people.value.candidates };

  let rolesState: Loading<readonly Role[]> = { status: "loading" };
  if (served.status === "error") rolesState = { status: "error", error: served.error, kind: served.kind, retry: action("access.roles.retry", t("common.tryAgain"), retry.roles) };
  else if (served.status === "ready") rolesState = { status: "ready", value: served.value.roles };

  // Until the role list is read, the signed-in role alone, so the profile can name it. Nothing in it is offered for choosing.
  const own = ownRole ? [{ id: ownRole.id, name: ownRole.name, description: t("access.currentSignedInRole"), permissions: ownRole.permissions, builtIn: false, protected: false, assignable: false, version: 0, holders: 0, editable: false, deletable: false }] : [];
  return {
    candidates,
    members: people.status === "ready" ? people.value.members : [self],
    roles: served.status === "ready" ? served.value : { roles: own, permissions: [], defaultRoleId: null },
    rolesState,
    requestCount: canManage && candidates.status === "ready" ? candidates.value.length : null,
    working: state.working,
  };
}

export function useAccessDirectory(opts: Readonly<{ session: ActiveSession; canRead: boolean; canManage: boolean; notify: Notify; api?: DirectoryApi }>): AccessDirectory {
  const api = useApi();
  const { session, canRead, canManage } = opts;
  const notifyRef = useRef(opts.notify);
  notifyRef.current = opts.notify;
  const store = useMemo(() => new AccessDirectoryStore(opts.api ?? directoryApi(api), (input) => notifyRef.current(input)), [opts.api, api]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => { if (canManage) void store.readPeople(false); }, [store, canManage]);
  useEffect(() => { if (canRead) void store.readRoles(false); }, [store, canRead]);

  const refresh = useCallback(() => { if (canManage) void store.readPeople(true); }, [store, canManage]);
  const self = useMemo<Member>(() => ({ id: session.identity.id, name: session.identity.displayName, roleId: session.identity.roleId, links: [], canDelete: false, photoUrl: session.profile.photoUrl }), [session]);
  return {
    ...readDirectory(state, { self, ownRole: session.role, canManage }, { people: () => void store.readPeople(false), roles: () => void store.readRoles(false) }),
    setMembers: (members) => store.setMembers(members),
    refresh,
    refreshRoles: () => store.readRoles(true),
    approve: (candidate, roleId) => store.approve(candidate, roleId),
    dismiss: (candidate) => store.dismiss(candidate),
    changeRole: (member, roleId) => store.changeRole(member, roleId),
  };
}
