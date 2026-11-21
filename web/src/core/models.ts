import type { ReactNode } from "react";

import type { AccessCandidate, AccessInvitation, ApiFailureKind, BackupEntry, HostMetrics, LinkedLoginAccount, MetricRange, SubscriptionState } from "../api/contract";
import type { StatusDescriptor } from "./status";
import type { AccessTab, ControlPlaneSnapshot, Game, Member, Operation, OwnerBootstrap, Page, Preset, Role, ServerState, Wipe, World, WorldTab } from "../model";
import type { WorldsView } from "../routing";
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
  setPreference: (next: ThemePreference) => Promise<void>;
  setAccent: (next: string) => Promise<void>;
}>;

/** A world of the scoped game, as data a frame can list and link to; its verbs are asked for through `ShellModel.worldActions`. */
export type ShellWorld = Readonly<{ id: string; name: string; href: string; status: StatusDescriptor }>;

/*
 * The optional fields below serve a skin that draws more than the list of
 * worlds (the cloud skin). Actions there are asked for through functions, so
 * a skin that ignores them is never asked to draw them.
 */
export type ShellModel = Readonly<{
  navigation: readonly NavigationItem[];
  page: Page;
  scope: ScopeModel;
  viewer: ViewerProfile;
  demo: boolean;
  observedAt: string | undefined;
  openProfile: Action;
  /** The scoped game's home: the worlds page as an overview. `navigation` keeps its Worlds item current there too. */
  overview?: NavigationItem;
  /** The snapshot's own time, for a relative "refreshed" line. */
  observedAtIso?: string;
  worlds?: readonly ShellWorld[];
  /** People waiting for access, as the Access page lists them, when they were read; null or absent while unknown. */
  requests?: number | null;
  refreshAction?: () => Action;
  /** Start or stop and invite for one world of the scoped game; null for a world it does not list. */
  worldActions?: (worldId: string) => Readonly<{ session: Action; invite: Action | null }> | null;
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
  /** "Rostik online", the active world and its state. */
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
  wipe: Readonly<{ number: number }> | null;
  /** What stands where a wipe would: "Legacy world", "No wipes yet". */
  wipeAbsent: string;
  address: AddressFacts | null;
  addressAbsent: string;
  actions: readonly Action[];
  /** Players on this world's own session; null when unknown or none runs. */
  players?: number | null;
  /** When the host this world runs on was launched, where core can tell. */
  launchedAt?: string | null;
  /** Start or stop, with the reason it may be refused (the world page's verb). */
  sessionAction?: () => Action;
}>;

/** One running operation of the game, named by the world it holds. */
export type OperationRow = Readonly<{ operation: Operation; label: string; worldName: string; href: string }>;

/** One person asking for access, as data (`since` is an ISO time); approve and dismiss come from `WorldsModel.requestActions`. */
export type RequestSummary = Readonly<{ id: string; displayName: string; platform: AccessCandidate["platform"]; account: string; since: string; photoUrl: string | null }>;

export type WorldsModel = Readonly<{
  status: "loading" | "ready" | "error";
  error: string;
  game: Game | undefined;
  /** Why a list is not shown: no games at all, or the read failed. */
  unavailable: Readonly<{ failed: boolean; description: string }> | null;
  notices: readonly Notice[];
  overview: SessionOverview;
  rows: readonly WorldRow[];
  /** Why the list is empty and no world can be created; null when Create world says enough. */
  emptyDescription: string | null;
  refresh: Action;
  createWorld: Action | null;
  /** Absent means "list". */
  view?: WorldsView;
  views?: Readonly<{ overview: string; list: string }>;
  operations?: readonly OperationRow[];
  builds?: readonly Readonly<{ preset: Preset; status: StatusDescriptor }>[];
  /** People waiting for access, as the Access page lists them; null without the role to manage access. */
  requests?: Loading<readonly RequestSummary[]> | null;
  requestActions?: (id: string) => Readonly<{ approve: Action; dismiss: Action }> | null;
}>;

// --- one world ---------------------------------------------------------------

export type DetailValue =
  | Readonly<{ type: "text"; text: string; mono?: boolean }>
  | Readonly<{ type: "absent"; text: string }>
  | Readonly<{ type: "status"; status: StatusDescriptor }>
  | Readonly<{ type: "time"; at: string | number | null | undefined }>
  | Readonly<{ type: "number"; value: number }>
  | Readonly<{ type: "release"; active: string | null; desired: string | null }>
  | Readonly<{ type: "address"; address: AddressFacts }>
  /** A preset's name and, when it was built from Git, the commit it came from. */
  | Readonly<{ type: "preset"; name: string; source: Readonly<{ commit: string; short: string; href: string }> | null }>;

/** What a detail is about, so a skin that shows a fact elsewhere can leave it out here. */
export type DetailKey = "session" | "host" | "launched" | "players" | "observed" | "world-id" | "availability" | "preset" | "release" | "wipe" | "address" | "hosting" | "connection" | "game-settings";

export type Detail = Readonly<{
  key?: DetailKey;
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
  /** The archive itself (ADR-0065); null when the role or the deployment offers no download. */
  download: ((entry: BackupEntry) => Action) | null;
}>;

/** `downloads`: the client pack, or with side lists (ADR-0069) the client, server and full packs. */
export type ReleaseRow = Readonly<{ name: string; status: string; downloadable: boolean; sourceHref: string | null; downloads: readonly Action[] }>;

/** One player on a world's whitelist, and the way off it (ADR-0066). */
export type WhitelistRow = Readonly<{ name: string; remove: Action }>;
export type WhitelistModel = Readonly<{
  world: World;
  /** The names the world's record keeps; managed is false while it keeps none. */
  list: Loading<Readonly<{ managed: boolean; rows: readonly WhitelistRow[]; updatedAt: string | null; updatedBy: string | null }>>;
  draft: string;
  setDraft: (value: string) => void;
  /** Why the draft cannot be added; null while it is empty or can be. */
  draftError: string | null;
  add: Action;
}>;

/** One mod of the release a world starts with, of either side, and its download (ADR-0065, ADR-0069). */
export type ModRow = Readonly<{ file: string; bytes: number; sha256: string; download: Action }>;
/** `split`: players install a set of their own, so the release offers its server and full packs too. */
export type ModsModel = Readonly<{ release: string; split: boolean; files: Loading<readonly ModRow[]> }>;

export type WorldModel = Readonly<{
  game: Game;
  world: World;
  worldsHref: string;
  availability: StatusDescriptor;
  /** This world's own session, never the game's (ADR-0062). */
  sessionStatus: StatusDescriptor;
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
  releases: Readonly<{
    rows: readonly ReleaseRow[];
    state: World["release"]["state"];
    /** The server mods of the release the world starts with; null when none can be read. */
    mods: ModsModel | null;
  }>;
  /** The players who may join; null when the role, the game or the world keeps no whitelist here. */
  whitelist: WhitelistModel | null;
  /** This world's console and its host's metrics; null when the role or the deployment offers neither tab. */
  console: ConsoleModel | null;
  metrics: MetricsModel | null;
  /** Every world of the game, this one included, as data. */
  siblings?: readonly SiblingRow[];
  glance?: WorldGlance;
}>;

export type SiblingRow = Readonly<{
  id: string;
  name: string;
  href: string;
  status: StatusDescriptor;
  releaseSummary: string;
  wipe: number | null;
  players: number | null;
  placement: WorldPlacement;
  address: AddressFacts | null;
}>;

/** This world's session in a few facts; `busy` while an operation holds it. */
export type WorldGlance = Readonly<{ live: boolean; players: number | null; address: AddressFacts | null; launchedAt: string | null; busy: boolean }>;

// --- other console pages -----------------------------------------------------

/** The host one world runs on, measured (ADR-0062): never another world's. */
export type MetricsModel = Readonly<{
  range: MetricRange;
  ranges: readonly Readonly<{ id: MetricRange; label: string }>[];
  setRange: (range: MetricRange) => void;
  /** Ready with null when the world runs on no host, as a stopped fleet world does. */
  metrics: Loading<HostMetrics | null>;
}>;

/** One command in the console's log and what the game answered (ADR-0063). */
export type ConsoleLine = Readonly<{
  id: string;
  at: string;
  who: string;
  command: string;
  status: StatusDescriptor;
  output: string | null;
  pending: boolean;
}>;

export type ConsoleModel = Readonly<{
  game: Game | undefined;
  /** The world the console speaks to, and its session's state. */
  world: World | null;
  session: StatusDescriptor;
  online: boolean;
  /** Newest last, as a terminal prints; null while no world runs. */
  log: Loading<readonly ConsoleLine[]> | null;
  draft: string;
  setDraft: (value: string) => void;
  run: Action;
  quickCommands: readonly Action[];
  /** Why the console cannot be used right now, when it cannot. */
  unavailable: string | null;
}>;

export type PresetRow = Readonly<{ preset: Preset; status: StatusDescriptor; createWorld: Action | null; build?: Action | null }>;
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
  /** `label` names what is typed: "World ID" for a purge. */
  typedConfirmation: Readonly<{ label: string; expected: string; value: string; set: (value: string) => void }> | null;
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

/** One game setting in the sheet (ADR-0064), drawn by its kind. */
export type GameSettingField = Readonly<{ id: string; label: string; hint?: string } & (
  | { kind: "choice"; value: string; options: readonly Readonly<{ value: string; label: string }>[]; set: (value: string) => void }
  | { kind: "number"; value: string; min: number; max: number; set: (value: string) => void; error: string | null }
  | { kind: "text"; value: string; maxLength: number; set: (value: string) => void; error: string | null }
  | { kind: "toggle"; checked: boolean; toggle: Action }
)>;

export type GameSettingsModel = Readonly<{
  game: Game;
  world: World;
  /** The world runs, so what is saved reaches it at its next start. */
  running: boolean;
  fields: readonly GameSettingField[];
  save: Action;
  restoreDefaults: Action;
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
  gameSettings: GameSettingsModel | null;
  invitation: InvitationModel | null;
}>;

// --- the console --------------------------------------------------------------

export type PageModel =
  | Readonly<{ page: "worlds"; worlds: WorldsModel }>
  | Readonly<{ page: "world"; world: WorldModel }>
  | Readonly<{ page: "releases"; releases: ReleasesModel }>
  | Readonly<{ page: "access"; access: AccessModel }>
  | Readonly<{ page: "profile"; profile: ProfileModel }>;

export type ConsoleShellModel = Readonly<{
  shell: ShellModel;
  content: PageModel;
  dialogs: DialogsModel;
  snapshot: ControlPlaneSnapshot | null;
}>;

export type BootModel = Readonly<{ title: string; description?: string }>;

export type Rendered = ReactNode;
