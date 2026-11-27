import factorio from "../../../server/games/factorio/game.json" with { type: "json" };
import minecraft from "../../../server/games/minecraft/game.json" with { type: "json" };
import minecraftSettings from "../../../server/games/minecraft/settings.json" with { type: "json" };
import palworld from "../../../server/games/palworld/game.json" with { type: "json" };
import palworldSettings from "../../../server/games/palworld/settings.json" with { type: "json" };
import valheim from "../../../server/games/valheim/game.json" with { type: "json" };
import valheimSettings from "../../../server/games/valheim/settings.json" with { type: "json" };
import zomboid from "../../../server/games/zomboid/game.json" with { type: "json" };
import type { GamePresentation } from "../../../contract/control-plane.ts";
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
  /** A session of this game may run on a Spot host (ADR-0102). Absent in the manifest means false. */
  spot: boolean;
  /** How a session saves on a Spot interruption (ADR-0103); null when the module declares none. */
  interruption: Interruption | null;
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
  /** How the skins draw it: a tint, a glyph and a scene, by name (ADR-0090). */
  presentation: GamePresentation;
  /** The game settings a world may carry (ADR-0064), as the module's settings.json states them. */
  settings: readonly Readonly<Record<string, unknown>>[];
  /** The .env keys the host reads from /spawnpoint/host/env/ for it; checked before a launch (ADR-0106). */
  requiredSecrets: readonly string[];
  /** How long the host waits for it to serve after `compose up` (ADR-0106). */
  startTimeoutSeconds: number;
}>;

/**
 * ADR-0103. `live`: game_save writes the world while it runs. `stop`: only a
 * graceful stop writes it, so the notice stops the game. The budget is the
 * measured worst case of that save.
 */
export type Interruption = Readonly<{ save: "live" | "stop"; saveBudgetSeconds: number }>;

/**
 * The longest save a Spot game may declare: the two-minute notice, less the
 * announcements, the flush, the report and a margin for a late watcher poll.
 */
export const INTERRUPTION_BUDGET_LIMIT_SECONDS = 90;

/** What the host waits when a manifest states no start_timeout_seconds, and the most one may state (ADR-0106). */
export const DEFAULT_START_TIMEOUT_SECONDS = 600;
const START_TIMEOUT_LIMIT_SECONDS = 3000;

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

const PRESENTATION_NAME = /^[a-z][a-z-]{0,31}$/;

// Names only: the skins own the pictures. A name a skin does not know draws its default.
function presentationOf(manifest: Manifest, id: string): GamePresentation {
  if (manifest.presentation === undefined) return { tint: null, glyph: null, scene: null };
  const raw = object(manifest.presentation, `${id} presentation`);
  const name = (value: unknown, what: string): string | null =>
    value === undefined ? null : field(value, (item): item is string => typeof item === "string" && PRESENTATION_NAME.test(item), `${id}.presentation.${what}`);
  return { tint: name(raw.tint, "tint"), glyph: name(raw.glyph, "glyph"), scene: name(raw.scene, "scene") };
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

function interruptionOf(manifest: Manifest, id: string): Interruption | null {
  if (manifest.interruption === undefined) return null;
  const block = object(manifest.interruption, `${id} interruption`);
  const save = block.save;
  if (save !== "live" && save !== "stop") throw new Error(`${id}.interruption.save must be live or stop`);
  const budget = field(block.save_budget_seconds, isNumber, `${id}.interruption.save_budget_seconds`);
  if (!Number.isInteger(budget) || budget < 1) throw new Error(`${id}.interruption.save_budget_seconds must be a whole number above zero`);
  return { save, saveBudgetSeconds: budget };
}

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

function requiredSecretsOf(manifest: Manifest, id: string): readonly string[] {
  const keys = field(manifest.required_secrets, isStringList, `${id}.required_secrets`);
  const bad = keys.find((key) => !ENV_KEY.test(key));
  if (bad !== undefined) throw new Error(`${id}.required_secrets names ${bad}, which is not an .env key`);
  return keys;
}

// The start document gives the host an hour; the start is only one part of it.
function startTimeoutOf(manifest: Manifest, id: string): number {
  if (manifest.start_timeout_seconds === undefined) return DEFAULT_START_TIMEOUT_SECONDS;
  const seconds = field(manifest.start_timeout_seconds, isNumber, `${id}.start_timeout_seconds`);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > START_TIMEOUT_LIMIT_SECONDS) {
    throw new Error(`${id}.start_timeout_seconds must be a whole number from 60 to ${START_TIMEOUT_LIMIT_SECONDS}`);
  }
  return seconds;
}

// A Spot host is taken back two minutes after its notice; a game that cannot
// say how it saves in that time does not go on one (ADR-0103).
function spotOf(capabilities: Manifest, interruption: Interruption | null, id: string): boolean {
  const spot = capabilities.spot === undefined ? false : field(capabilities.spot, isBoolean, `${id}.capabilities.spot`);
  if (!spot) return false;
  if (interruption === null) throw new Error(`${id}.capabilities.spot needs an interruption block`);
  if (interruption.saveBudgetSeconds > INTERRUPTION_BUDGET_LIMIT_SECONDS) {
    throw new Error(`${id}.interruption.save_budget_seconds exceeds ${INTERRUPTION_BUDGET_LIMIT_SECONDS}, so it cannot be on Spot`);
  }
  return true;
}

// A malformed manifest stops the bundle loading rather than placing a game wrongly.
// Exported for the contract tests, which feed it manifests that must be refused.
export function gameModule(raw: unknown, settings?: SettingsFile): GameModule {
  const manifest = object(raw, "game manifest");
  const id = field(manifest.id, isString, "id");
  const connect = object(manifest.connect, `${id} connect`);
  const footprint = object(manifest.footprint, `${id} footprint`);
  const capabilities = object(manifest.capabilities, `${id} capabilities`);
  const interruption = interruptionOf(manifest, id);
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
    spot: spotOf(capabilities, interruption, id),
    interruption,
    legacyDefault: manifest.legacy_default === true,
    presentation: presentationOf(manifest, id),
    console: consoleRules(manifest, id),
    whitelistRules: whitelistRules(manifest, id),
    configFileRules: configFileRules(manifest, id),
    buildsReleases: typeof manifest.release === "object" && manifest.release !== null,
    settings: settings?.settings ?? [],
    requiredSecrets: requiredSecretsOf(manifest, id),
    startTimeoutSeconds: startTimeoutOf(manifest, id),
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
