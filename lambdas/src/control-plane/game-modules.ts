import factorio from "../../../server/games/factorio/game.json" with { type: "json" };
import minecraft from "../../../server/games/minecraft/game.json" with { type: "json" };
import minecraftSettings from "../../../server/games/minecraft/settings.json" with { type: "json" };
import palworld from "../../../server/games/palworld/game.json" with { type: "json" };
import palworldSettings from "../../../server/games/palworld/settings.json" with { type: "json" };
import valheim from "../../../server/games/valheim/game.json" with { type: "json" };
import valheimSettings from "../../../server/games/valheim/settings.json" with { type: "json" };
import zomboid from "../../../server/games/zomboid/game.json" with { type: "json" };
import type { Footprint } from "../domain/placement.ts";

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
