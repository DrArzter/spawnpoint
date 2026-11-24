import factorio from "../../../server/games/factorio/game.json" with { type: "json" };
import minecraft from "../../../server/games/minecraft/game.json" with { type: "json" };
import minecraftSettings from "../../../server/games/minecraft/settings.json" with { type: "json" };
import palworld from "../../../server/games/palworld/game.json" with { type: "json" };
import palworldSettings from "../../../server/games/palworld/settings.json" with { type: "json" };
import valheim from "../../../server/games/valheim/game.json" with { type: "json" };
import valheimSettings from "../../../server/games/valheim/settings.json" with { type: "json" };
import zomboid from "../../../server/games/zomboid/game.json" with { type: "json" };
import type { Footprint } from "../domain/placement.ts";
import type { WhitelistRules } from "./whitelist.ts";
import type { ConfigFileRules } from "./world-config.ts";

/*
 * The one place the Lambdas list the game modules (ADR-0088). Each module's
 * manifest (server/games/<id>/game.json) is what the host, Terraform and the
 * release builder read too; nothing here repeats a fact it holds. A test fails
 * when a module folder is missing from this list.
 */

export type GameModule = Readonly<{
  id: string;
  code: string;
  displayName: string;
  /** The port a player types; the host part of an address is the connectivity's (ADR-0033). */
  connectPort: number;
  /** The client fills in connectPort by itself, so an address on it is shown without it. */
  portImplied: boolean;
  /** False for a game whose server tells its clients which port to continue on: it runs on slot zero only. */
  slottable: boolean;
  footprint: Footprint;
  /** The game keeps a whitelist the host can write from a world's record (ADR-0066). */
  whitelist: boolean;
  /** This module owns the records written before games were an axis, which name no game (ADR-0089). */
  legacyDefault: boolean;
  /** What its console refuses (commands that end the game outside its lifecycle) and offers (ADR-0063). */
  console: Readonly<{ lifecycleCommands: readonly string[]; suggestions: readonly string[] }>;
  /** The config files a world may keep its own version of (ADR-0093); null when it may keep none. */
  configFileRules: ConfigFileRules | null;
  /** The rules of its whitelist, when it keeps one (ADR-0066, ADR-0090). */
  whitelistRules: WhitelistRules | null;
  /** Presets of this game build releases: its manifest has release facts (ADR-0034). */
  buildsReleases: boolean;
  /** The game settings a world may carry (ADR-0064), as the module's settings.json states them. */
  settings: readonly Readonly<Record<string, unknown>>[];
}>;

type Manifest = Readonly<Record<string, unknown>>;
type SettingsFile = Readonly<{ settings: readonly Readonly<Record<string, unknown>>[] }>;

function object(value: unknown, what: string): Manifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} is not an object`);
  return value as Manifest;
}

function field<T>(value: unknown, check: (value: unknown) => value is T, what: string): T {
  if (!check(value)) throw new Error(`game manifest field ${what} is malformed`);
  return value;
}

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function consoleRules(manifest: Manifest, id: string): GameModule["console"] {
  const rules = object(manifest.console, `${id} console`);
  return {
    lifecycleCommands: field(rules.lifecycle_commands, isStringList, `${id}.console.lifecycle_commands`).map((command) => command.toLowerCase()),
    suggestions: field(rules.suggestions, isStringList, `${id}.console.suggestions`),
  };
}

function whitelistRules(manifest: Manifest, id: string): WhitelistRules | null {
  if (manifest.whitelist === undefined) return null;
  const rules = object(manifest.whitelist, `${id} whitelist`);
  const optional = (value: unknown, what: string): RegExp | null => value === undefined ? null : new RegExp(field(value, isString, what));
  return {
    namePattern: new RegExp(field(rules.name_pattern, isString, `${id}.whitelist.name_pattern`)),
    nameHint: field(rules.name_hint, isString, `${id}.whitelist.name_hint`),
    listCommand: rules.list_command === undefined ? null : field(rules.list_command, isString, `${id}.whitelist.list_command`),
    listReply: optional(rules.list_reply, `${id}.whitelist.list_reply`),
    listEmpty: optional(rules.list_empty, `${id}.whitelist.list_empty`),
  };
}

function configFileRules(manifest: Manifest, id: string): ConfigFileRules | null {
  if (manifest.config_files === undefined) return null;
  const rules = object(manifest.config_files, `${id} config_files`);
  return {
    roots: field(rules.roots, isStringList, `${id}.config_files.roots`),
    maxBytes: field(rules.max_bytes, isNumber, `${id}.config_files.max_bytes`),
    textExtensions: field(rules.text_extensions, isStringList, `${id}.config_files.text_extensions`),
  };
}

// A malformed manifest stops the bundle loading rather than placing a game wrongly.
function gameModule(raw: unknown, settings?: SettingsFile): GameModule {
  const manifest = object(raw, "game manifest");
  const id = field(manifest.id, isString, "id");
  const connect = object(manifest.connect, `${id} connect`);
  const footprint = object(manifest.footprint, `${id} footprint`);
  const capabilities = object(manifest.capabilities, `${id} capabilities`);
  return {
    id,
    code: field(manifest.code, isString, `${id}.code`),
    displayName: field(manifest.display_name, isString, `${id}.display_name`),
    connectPort: field(connect.port, isNumber, `${id}.connect.port`),
    portImplied: connect.port_implied === true,
    slottable: field(manifest.slottable, isBoolean, `${id}.slottable`),
    footprint: {
      memoryMiB: field(footprint.memory_mib, isNumber, `${id}.footprint.memory_mib`),
      cores: field(footprint.cores, isNumber, `${id}.footprint.cores`),
    },
    whitelist: field(capabilities.whitelist, isBoolean, `${id}.capabilities.whitelist`),
    legacyDefault: manifest.legacy_default === true,
    console: consoleRules(manifest, id),
    whitelistRules: whitelistRules(manifest, id),
    configFileRules: configFileRules(manifest, id),
    buildsReleases: typeof manifest.release === "object" && manifest.release !== null,
    settings: settings?.settings ?? [],
  };
}

/** In the order the panel lists the games. */
export const gameModules: readonly GameModule[] = [
  gameModule(minecraft, minecraftSettings),
  gameModule(factorio),
  gameModule(zomboid),
  gameModule(valheim, valheimSettings),
  gameModule(palworld, palworldSettings),
];

export function findGameModule(id: string): GameModule | undefined {
  return gameModules.find((module) => module.id === id);
}

function onlyLegacyDefault(modules: readonly GameModule[]): string {
  const owners = modules.filter((module) => module.legacyDefault);
  if (owners.length !== 1) throw new Error("exactly one game manifest must set legacy_default");
  return owners[0]!.id;
}

/** The game a record belongs to when it names none (ADR-0089). */
export const LEGACY_GAME_ID: string = onlyLegacyDefault(gameModules);
