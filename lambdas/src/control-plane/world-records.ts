import type { PresetObservation } from "./preset-catalog.ts";
import type { SwitchOutcome, SwitchRequest } from "./release-switch.ts";
import type { WorldGameSettings, WorldRecord, WorldWhitelist } from "./world-registry.ts";

/** What a change to a stored world record came to. */
export type WorldChange = "updated" | "missing" | "archived" | "conflict";

/** World records and their release pointers in storage (ADR-0062, ADR-0064, ADR-0066, ADR-0078). */
export type WorldRecords = Readonly<{
  read: (worldId: string) => Promise<WorldRecord | null>;
  /** Stores a world created from a preset, with its first release pointer; idempotent for the same proposal. */
  materialize: (
    preset: PresetObservation,
    identity: Readonly<{ worldId: string; displayName: string; release: string }>,
    generationUuid: string,
    createdAt: string,
    access?: Readonly<{ placement?: WorldRecord["placement"]; connectivity: WorldRecord["connectivity"]; auth?: WorldRecord["auth"] }>,
  ) => Promise<WorldRecord>;
  replaceGameSettings: (gameId: string, worldId: string, gameSettings: WorldGameSettings) => Promise<WorldChange>;
  replaceWhitelist: (gameId: string, worldId: string, whitelist: WorldWhitelist) => Promise<WorldChange>;
  replaceAccess: (
    gameId: string,
    worldId: string,
    access: Readonly<{ placement: WorldRecord["placement"]; connectivity: WorldRecord["connectivity"]; auth?: WorldRecord["auth"]; warm?: boolean }>,
  ) => Promise<Exclude<WorldChange, "archived">>;
  switchReleaseBeforeFirstStart: (request: SwitchRequest) => Promise<SwitchOutcome>;
}>;
