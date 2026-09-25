import type { ReactNode } from "react";

import type { AccessCandidate, AccessInvitation, ApiFailureKind, BackupEntry, HostMetrics, LinkedLoginAccount, MetricRange, SubscriptionState } from "../api/contract";
import type { StatusDescriptor } from "../components/ui/Status";
import type { AccessTab, ControlPlaneSnapshot, Game, Member, Operation, OwnerBootstrap, Page, Preset, Role, ServerState, Wipe, World, WorldTab } from "../model";
import type { SessionReason } from "../session";
import type { Theme, ThemePreference, ViewerProfile } from "../telegram";
import type { Action } from "./actions";

/*
 * The bones hand each surface one of these. A model carries facts and
 * actions and nothing about how they look: no class names, no icons of its
 * own, no markup. A skin is a set of views that draw them, and the skin
 * contract test checks that every action in a model reaches the screen.
 *
 * Every value here is data a view can render directly, so a skin never has to
 * reach back into the API or into the domain helpers to finish a sentence.
 */

export type Loading<T> = Readonly<{ status: "loading" } | { status: "ready"; value: T } | { status: "error"; error: string; kind: ApiFailureKind; retry: Action }>;

// --- shell -----------------------------------------------------------------

export type NavigationItem = Readonly<{ id: Page; label: string; href: string; current: boolean }>;

export type ScopeModel = Readonly<{
  /** The scoped game, or nothing when the control plane lists none. */
  game: Game | undefined;
  games: readonly Game[];
  statusOf: (game: Game) => StatusDescriptor;
  open: boolean;
  show: Action;
  close: Action;
  select: (gameId: string) => void;
}>;

export type AppearanceModel = Readonly<{
  preference: ThemePreference;
  theme: Theme;
  accent: string;
  label: string;
  setPreference: (next: ThemePreference) => Promise<void>;
  setAccent: (next: string) => Promise<void>;
}>;

export type ShellModel = Readonly<{
  navigation: readonly NavigationItem[];
  page: Page;
  scope: ScopeModel;
  appearance: AppearanceModel;
  /** The bar's one-tap theme toggle. */
  cycleTheme: Action;
  viewer: ViewerProfile;
  demo: boolean;
  observedAt: string | undefined;
  openProfile: Action;
}>;

// --- worlds -----------------------------------------------------------------

export type Notice = Readonly<{ id: string; tone: "info" | "warning" | "error" | "success"; title: string; description?: string; action?: Action }>;

export type HostFacts = Readonly<{
  name: string;
  status: StatusDescriptor;
  instanceType: string | null;
  zone: string | null;
  launchedAt: string | null;
}>;

export type SessionOverview = Readonly<{
  fleet: boolean;
  state: ServerState;
  status: StatusDescriptor;
  /** "Minecraft online", the sentence a skin can set large. */
  headline: string;
  reason: SessionReason;
  players: number | null;
  observedAt: string | undefined;
  host: HostFacts | null;
  fleetHosts: Readonly<{ running: number; pending: number }>;
}>;

export type AddressFacts = Readonly<{ value: string; connectivity: World["connectivity"]; network: string }>;

export type WorldRow = Readonly<{
  world: World;
  href: string;
  status: StatusDescriptor;
  presetName: string;
  releaseSummary: string;
  wipe: Readonly<{ number: number; openedAt: string }> | null;
  /** What stands where a wipe would: "Legacy world", "No wipes yet". */
  wipeAbsent: string;
  address: AddressFacts | null;
  addressAbsent: string;
  actions: readonly Action[];
}>;

export type WorldsModel = Readonly<{
  status: "loading" | "ready" | "error";
  error: string;
  game: Game | undefined;
  /** Why a list is not shown: no games at all, or the read failed. */
  unavailable: Readonly<{ failed: boolean; description: string }> | null;
  notices: readonly Notice[];
  overview: SessionOverview;
  rows: readonly WorldRow[];
  emptyDescription: string;
  refresh: Action;
  createWorld: Action | null;
}>;

// --- one world ---------------------------------------------------------------

export type DetailValue =
  | Readonly<{ type: "text"; text: string; mono?: boolean }>
  | Readonly<{ type: "absent"; text: string }>
  | Readonly<{ type: "status"; status: StatusDescriptor }>
  | Readonly<{ type: "time"; at: string | number | null | undefined }>
  | Readonly<{ type: "number"; value: number }>
  | Readonly<{ type: "release"; active: string | null; desired: string | null }>
  | Readonly<{ type: "address"; address: AddressFacts }>;

export type Detail = Readonly<{
  label: string;
  value: DetailValue;
  hint?: string;
  hintAttention?: boolean;
  hintTime?: string | number | null;
  explain?: string;
  copy?: string;
}>;

export type BackupsModel = Readonly<{
  canRead: boolean;
  canRestore: boolean;
  filter: string | null;
  setFilter: (wipeId: string | null) => void;
  wipes: readonly Wipe[];
  inventory: Loading<Readonly<{ entries: readonly BackupEntry[]; unverified: number; truncated: boolean }>>;
  wipeNumber: (generationId: string | null) => number | undefined;
  restore: (entry: BackupEntry) => Action;
}>;

export type ReleaseRow = Readonly<{ name: string; status: string; downloadable: boolean; download: Action | null }>;

export type WorldModel = Readonly<{
  game: Game;
  world: World;
  worldsHref: string;
  availability: StatusDescriptor;
  notices: readonly Notice[];
  tabs: readonly Readonly<{ id: WorldTab; label: string; count?: number }>[];
  tab: WorldTab;
  setTab: (tab: WorldTab) => void;
  /** Start or stop, with the reason it may be refused. */
  session: Action;
  refresh: Action;
  invite: Action | null;
  /** The overflow: pack, hosting, wipe, archive, purge. */
  more: readonly Action[];
  sessionDetails: readonly Detail[];
  worldDetails: readonly Detail[];
  operations: readonly Readonly<{ operation: Operation; label: string }>[];
  wipes: readonly Readonly<{ wipe: Wipe; showBackups: Action }>[];
  backups: BackupsModel;
  releases: Readonly<{ rows: readonly ReleaseRow[]; state: World["release"]["state"] }>;
}>;

// --- other console pages -----------------------------------------------------

export type MetricsModel = Readonly<{
  source: "cloudwatch" | "session";
  setSource: (source: "cloudwatch" | "session") => void;
  online: boolean;
  instanceId: string | undefined;
  range: MetricRange;
  ranges: readonly Readonly<{ id: MetricRange; label: string }>[];
  setRange: (range: MetricRange) => void;
  metrics: Loading<HostMetrics>;
}>;

export type ConsoleModel = Readonly<{
  game: Game | undefined;
  session: StatusDescriptor;
  online: boolean;
  quickCommands: readonly string[];
}>;

export type PresetRow = Readonly<{ preset: Preset; status: StatusDescriptor; createWorld: Action | null }>;
export type PointerRow = Readonly<{ world: World; href: string; presetName: string; summary: string }>;

export type ReleasesModel = Readonly<{
  game: Game | undefined;
  loading: boolean;
  presets: readonly PresetRow[];
  pointers: readonly PointerRow[];
}>;

// --- access ------------------------------------------------------------------

export type CandidateRow = Readonly<{
  candidate: AccessCandidate;
  account: string;
  since: string;
  roleId: string;
  setRoleId: (roleId: string) => void;
  approve: Action;
  dismiss: Action;
}>;

export type MemberRow = Readonly<{
  member: Member;
  roleId: string;
  setRoleId: (roleId: string) => void;
  changing: boolean;
  linkedAccounts: Action;
}>;

export type InvitationsModel = Readonly<{
  emailMode: boolean | null;
  email: string;
  setEmail: (value: string) => void;
  create: Action;
  issued: Readonly<{ url: string; email: string; copy: Action }> | null;
  list: Loading<readonly Readonly<{ invitation: AccessInvitation; revoke: Action | null }>[]>;
}>;

export type UsersModel = Readonly<{
  bootstrap: OwnerBootstrap;
  bootstrapDescription: string | undefined;
  candidates: Loading<readonly CandidateRow[]>;
  members: readonly MemberRow[];
  roles: readonly Role[];
  rolesLoading: boolean;
  invitations: InvitationsModel | null;
  managed: Member | null;
  closeManaged: Action;
}>;

export type RolesModel = Readonly<{
  roles: Loading<readonly Role[]>;
  reading: Role | null;
  read: (role: Role) => Action;
  closeReading: Action;
}>;

export type NotificationsModel = Readonly<{
  state: "loading" | "ready" | "saving" | "error";
  error: string;
  /** Present only while the load failed: there is nothing to retry otherwise. */
  retry: Action | null;
  saveStatus: string;
  games: readonly Game[];
  subscriptions: SubscriptionState;
  toggle: (id: string, label: string) => Action;
}>;

export type AccessModel = Readonly<{
  tab: AccessTab;
  setTab: (tab: AccessTab) => void;
  roleCount: number;
  users: UsersModel;
  roles: RolesModel;
  notifications: NotificationsModel;
}>;

// --- profile -----------------------------------------------------------------

export type LoginAccountsModel = Readonly<{
  accounts: Loading<readonly LinkedLoginAccount[]>;
  linkable: readonly string[];
  connectTelegram: ((idToken: string) => Promise<void>) | null;
  connectGoogle: ((idToken: string) => Promise<void>) | null;
  addPassword: Action | null;
  form: Readonly<{
    kind: "add" | "change";
    email: string;
    setEmail: (value: string) => void;
    currentPassword: string;
    setCurrentPassword: (value: string) => void;
    password: string;
    setPassword: (value: string) => void;
    confirmation: string;
    setConfirmation: (value: string) => void;
    error: string;
    busy: boolean;
    submit: Action;
    cancel: Action;
  }> | null;
  rowActions: (account: LinkedLoginAccount) => readonly Action[];
}>;

/** Which face the console wears; choosing one reloads the page in it. */
export type LookModel = Readonly<{
  current: string;
  options: readonly Readonly<{ id: string; name: string; choose: Action }>[];
}>;

export type ProfileModel = Readonly<{
  member: Member;
  role: Role | undefined;
  viewer: ViewerProfile;
  appearance: AppearanceModel;
  look: LookModel;
  signOut: Action;
  openInBrowser: Action | null;
  loginAccounts: LoginAccountsModel;
}>;

// --- dialogs and sheets ------------------------------------------------------

export type ConfirmationModel = Readonly<{
  title: string;
  description: string;
  destructive: boolean;
  confirm: Action;
  cancel: Action;
  releaseChoice: Readonly<{ value: string; options: readonly Readonly<{ version: string; latest: boolean }>[]; set: (value: string) => void }> | null;
  typedConfirmation: Readonly<{ expected: string; value: string; set: (value: string) => void }> | null;
}>;

export type WorldPlacement = "configured" | "fleet";

export type ConnectionFieldsModel = Readonly<{
  placement: WorldPlacement;
  setPlacement: (placement: WorldPlacement) => void;
  fleetAvailable: boolean;
  connectivity: World["connectivity"];
  setConnectivity: (connectivity: World["connectivity"]) => void;
  dnsAvailable: boolean;
}>;

export type CreateWorldModel = Readonly<{
  game: Game;
  presets: readonly Preset[];
  presetId: string;
  setPresetId: (id: string) => void;
  preset: Preset | null;
  name: string;
  setName: (value: string) => void;
  release: string;
  setRelease: (value: string) => void;
  connection: ConnectionFieldsModel;
  valid: boolean;
  submit: Action;
  cancel: Action;
}>;

export type WorldSettingsModel = Readonly<{
  game: Game;
  world: World;
  stopped: boolean;
  connection: ConnectionFieldsModel;
  valid: boolean;
  save: Action;
  cancel: Action;
}>;

export type InvitationModel = Readonly<{
  game: Game;
  world: World;
  audience: "broadcast" | "direct";
  setAudience: (audience: "broadcast" | "direct") => void;
  query: string;
  setQuery: (query: string) => void;
  recipients: Loading<readonly Readonly<{ id: string; displayName: string; photoUrl?: string | null; ready: boolean; delivery: string; selected: boolean; toggle: () => void }>[]>;
  reachable: number;
  selectedCount: number;
  clearSelection: Action;
  history: Loading<readonly Readonly<{ id: string; status: StatusDescriptor; audience: string; detail: string; createdAt: string }>[]>;
  refreshHistory: Action;
  send: Action;
  close: Action;
}>;

export type DialogsModel = Readonly<{
  confirmation: ConfirmationModel | null;
  createWorld: CreateWorldModel | null;
  worldSettings: WorldSettingsModel | null;
  invitation: InvitationModel | null;
}>;

// --- the console --------------------------------------------------------------

export type PageModel =
  | Readonly<{ page: "worlds"; worlds: WorldsModel }>
  | Readonly<{ page: "world"; world: WorldModel }>
  | Readonly<{ page: "metrics"; metrics: MetricsModel }>
  | Readonly<{ page: "console"; console: ConsoleModel }>
  | Readonly<{ page: "releases"; releases: ReleasesModel }>
  | Readonly<{ page: "access"; access: AccessModel }>
  | Readonly<{ page: "profile"; profile: ProfileModel }>;

export type ConsoleShellModel = Readonly<{
  shell: ShellModel;
  content: PageModel;
  dialogs: DialogsModel;
  snapshot: ControlPlaneSnapshot | null;
}>;

export type BootModel = Readonly<{ title: string; description: string }>;

export type Rendered = ReactNode;
