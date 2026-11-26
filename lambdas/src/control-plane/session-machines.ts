import type { StopPlayersPolicy } from "../domain/telegram-bot.ts";
import type { Footprint, HostMarket, SessionPolicy } from "../domain/placement.ts";

// The lifecycle machines' port. Each call starts one execution and answers its
// id; the execution is the operation record.

export type StartSessionRun = Readonly<{
  operationId: string;
  instanceId: string;
  requestedBy: string;
  /** The lifecycle record's key: the game's, or a fleet world's own (ADR-0062). */
  serverId: string;
  gameId: string;
  worldId: string;
  worldName: string;
  placement?: "single" | "shared" | "fleet";
  /** A fleet world's warm choice (ADR-0048); left out, the machine places it cold. */
  policy?: SessionPolicy;
  /** `on-demand` keeps a fleet world off Spot (ADR-0102); left out, Spot where allowed. */
  market?: HostMarket;
  /** The world's preset footprint; left out, the game's (ADR-0054). */
  footprint?: Footprint;
}>;

export type StopSessionRun = Readonly<{
  operationId: string;
  instanceId: string;
  requestedBy: string;
  serverId: string;
  sessionId: string;
  worldId: string;
  players?: StopPlayersPolicy;
}>;

/** A fleet world's release promotion (ADR-0078). Its machines find the host from the placement. */
export type PromotionRun = Readonly<{
  operationId: string;
  serverId: string;
  gameId: string;
  presetId: string;
  worldId: string;
  worldName: string;
  generationId: string;
  release: string;
  policy: SessionPolicy;
  market?: HostMarket;
  footprint?: Footprint;
  requestedBy: string;
  /** False stops a world that was stopped before its update again; by default it keeps running (ADR-0078). */
  startAfter?: boolean;
}>;

export type WorldLifecycleRun = Readonly<{
  operationId: string;
  instanceId: string;
  requestedBy: string;
  serverId: string;
  sessionId: string;
  worldId: string;
  action: "archive" | "regenerate" | "restore" | "purge";
  backupKey: string | undefined;
  release: string | undefined;
  stopRequired: boolean;
  targetGenerationId: string;
}>;

export type SessionMachines = Readonly<{
  start: (run: StartSessionRun) => Promise<string>;
  stop: (run: StopSessionRun) => Promise<string>;
  promote: (run: PromotionRun) => Promise<string>;
  worldLifecycle: (run: WorldLifecycleRun) => Promise<string>;
}>;
