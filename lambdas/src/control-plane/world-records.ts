import type { PresetObservation } from "./preset-catalog.ts";
import type { SwitchOutcome, SwitchRequest } from "./release-switch.ts";
import type { WorldGameSettings, WorldRecord, WorldWhitelist } from "./world-registry.ts";
import type { WorldConfigFiles } from "./world-config.ts";

/** A change to a world's config files, from the files it holds now; a refusal leaves the record as it is. */
export type ConfigFilesUpdate = (current: WorldConfigFiles) => Readonly<{ files: WorldConfigFiles } | { refused: "config_file_changed" | "unknown_config_file" }>;

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
  /** Applies `update` to the record as stored, conditional on its version (ADR-0093). */
  updateConfigFiles: (gameId: string, worldId: string, update: ConfigFilesUpdate) => Promise<WorldChange | "config_file_changed" | "unknown_config_file">;
  replaceAccess: (
    gameId: string,
    worldId: string,
    access: Readonly<{ placement: WorldRecord["placement"]; connectivity: WorldRecord["connectivity"]; auth?: WorldRecord["auth"]; warm?: boolean; onDemand?: boolean }>,
  ) => Promise<Exclude<WorldChange, "archived">>;
  switchReleaseBeforeFirstStart: (request: SwitchRequest) => Promise<SwitchOutcome>;
}>;
