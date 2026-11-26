// What GET /control-plane sends: the games, their worlds and presets, the hosts
// and the running operations, as one viewer may see them.
import type { SettingDefinition, SettingValue } from "./settings.ts";

export type BuildStatus = "unbuilt" | "building" | "ready" | "failed";

/** The build of a preset's current revision, while one is asked for or after it ran. */
export type PresetBuild = Readonly<{
  release: string;
  attempt: number;
  state: "starting" | "building" | "ready" | "failed";
  requestedAt: string;
  profileDigest: string;
}>;

export type Preset = Readonly<{
  id: string;
  displayName: string;
  repository: string;
  commit: string;
  profileDigest: string;
  releases: readonly string[];
  /** The state of the build of the current revision, not of the releases. */
  buildStatus: BuildStatus;
  /** The newest published release, whatever revision it was built from. */
  latestRelease: string | null;
  /** The releases built from an older revision than the current one (ADR-0042). */
  olderReleases?: readonly string[];
  buildAvailable?: boolean;
  build?: PresetBuild;
}>;

/** The preset a world was created from, as the world carries it. */
export type WorldPreset = Readonly<{
  id: string;
  repository: string;
  commit: string;
  profileDigest: string;
  releases: readonly string[];
  buildStatus: BuildStatus;
  latestRelease: string | null;
  olderReleases?: readonly string[];
}>;

export type Wipe = Readonly<{
  id: string;
  number: number;
  state: "current" | "closed";
  createdAt: string;
  closedAt: string | null;
  originRelease: string;
}>;

export type ReleasePointer = Readonly<{
  state: "available" | "unconfigured" | "unavailable";
  generationId: string | null;
  /** Null for a viewer who may not read releases. */
  desiredRelease: string | null;
  activeRelease: string | null;
  /** How many releases this wipe has run; absent when the pointer is not read (ADR-0078). */
  runCount?: number;
}>;

/** The watchdog's last reading of a session. */
export type SessionIdle = Readonly<{
  /** Null is a read that failed, which is not the same as nobody online. */
  playersOnline: number | null;
  consecutiveEmpty: number;
  lastObservedAtEpochSeconds: number | null;
  /** Until when the reading says who is online. */
  freshUntilEpochSeconds: number | null;
}>;

/** A session record as a viewer may know it: never the lease or the fence. */
export type WorldSession = Readonly<{
  serverId: string;
  desiredState: "stopped" | "running";
  observedState: "stopped" | "starting" | "ready" | "stopping" | "unknown";
  activeSessionId: string | null;
  activeWorldId: string | null;
  /** Present while a watchdog is registered for the session. */
  idle: SessionIdle | null;
  /** When the session became ready: its uptime starts here. */
  readyAtEpochSeconds?: number | null;
  updatedAtEpochSeconds: number;
}>;

export type WorldGameSettings = Readonly<{ values: Readonly<Record<string, SettingValue>>; updatedAt: string | null }>;

export type World = Readonly<{
  id: string;
  displayName: string;
  profileId: string;
  sessionControlAvailable: boolean;
  /** Null for a viewer who may not read the connection. */
  connectionAddress: string | null;
  connectivity: "zerotier" | "raw" | "route53";
  placement: "configured" | "fleet";
  auth: "game" | "external" | null;
  materialization: "existing" | "not_created" | "archived";
  preset: WorldPreset | null;
  wipes: readonly Wipe[];
  release: ReleasePointer;
  /** This world's session, wherever it lives (ADR-0062); null when it has none. */
  session: WorldSession | null;
  /** The game settings this world sets (ADR-0064); null when it has no record to keep them in. */
  gameSettings: WorldGameSettings;
}>;

/** A game's look, named rather than drawn: each skin owns the picture for a name and a default for none. */
export type GamePresentation = Readonly<{ tint: string | null; glyph: string | null; scene: string | null }>;

export type Game = Readonly<{
  id: string;
  code: string;
  displayName: string;
  /** The game's session record. */
  lifecycle: WorldSession | null;
  /** What a world of this game may set (ADR-0064); empty when the game defines nothing. */
  settings: readonly SettingDefinition[];
  /** The game keeps a whitelist a world's record can hold (ADR-0066). */
  whitelist: boolean;
  /** What a whitelisted player's name must match, and the words that say so; null without a whitelist (ADR-0090). */
  playerName: Readonly<{ pattern: string; hint: string }> | null;
  /** Commands the console offers to type, as the game's module lists them. */
  consoleSuggestions: readonly string[];
  /** How a skin draws the game, in each skin's own vocabulary: a tint, a glyph and a scene name; null for the default (ADR-0090). */
  presentation: GamePresentation;
  presets: readonly Preset[];
  worlds: readonly World[];
}>;

export type HostState = "pending" | "running" | "stopping" | "stopped" | "unknown";

/** The infrastructure fields are present only for a viewer who manages access. */
export type Host = Readonly<{
  id: string;
  name: string;
  state: HostState;
  provenance: "configured" | "launched";
  providerRef?: string;
  instanceType?: string | null;
  availabilityZone?: string | null;
  launchedAt?: string | null;
}>;

export type OperationType = "start" | "stop" | "promote" | "world" | "host";

export type Operation = Readonly<{
  id: string;
  type: OperationType;
  status: "running";
  startedAt: string;
  /** The world the workflow's input names; null blocks every world (ADR-0062). */
  worldId: string | null;
  /** Present for a viewer who manages access. */
  providerRef?: string;
  /** The usual duration of this type for this world; absent with too little history. */
  expectedSeconds?: number;
  expectedSamples?: number;
}>;

export type Deployment = Readonly<{
  placement: "single" | "shared" | "fleet";
  launchEnabled: boolean;
  dnsAvailable: boolean;
}>;

export type ControlPlaneSnapshot = Readonly<{
  observedAt: string;
  games: readonly Game[];
  hosts: readonly Host[];
  operations: readonly Operation[];
  deployment: Deployment;
}>;
