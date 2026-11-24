import minecraftDefinitions from "../../../server/games/minecraft/settings.json" with { type: "json" };
import palworldDefinitions from "../../../server/games/palworld/settings.json" with { type: "json" };
import valheimDefinitions from "../../../server/games/valheim/settings.json" with { type: "json" };
import { type SettingDefinition, type SettingValue, settingValueValid } from "../../../contract/settings.ts";

export { type SettingDefinition, type SettingValue, settingValueValid };

/*
 * A world's game settings (ADR-0064). The definitions are the game module's
 * own file, which the host reads to export them: one list says what may be
 * set, what each value may be, and what it is when nobody set it. A setting
 * the platform depends on (ports, RCON, whitelist, online mode, the level
 * folder, memory) is never in the list.
 */


type RawDefinition = Readonly<Record<string, unknown>>;

// The file is code reviewed and also checked by the host's test; a malformed
// one stops the bundle loading rather than offering a setting nobody can save.
function definition(raw: RawDefinition): SettingDefinition {
  const common = { id: String(raw.id), label: String(raw.label), ...(typeof raw.hint === "string" ? { hint: raw.hint } : {}) };
  switch (raw.type) {
    case "choice":
      return { ...common, type: "choice", default: String(raw.default), choices: (raw.choices as { value: string; label: string }[]).map((choice) => ({ value: choice.value, label: choice.label })) };
    case "integer":
      return { ...common, type: "integer", default: Number(raw.default), min: Number(raw.min), max: Number(raw.max) };
    case "boolean":
      return { ...common, type: "boolean", default: raw.default === true };
    case "text":
      return { ...common, type: "text", default: String(raw.default), maxLength: Number(raw.max_length), pattern: String(raw.pattern) };
    default:
      throw new Error(`unknown game setting type: ${String(raw.type)}`);
  }
}

const definitionsByGame: Readonly<Record<string, readonly SettingDefinition[]>> = {
  minecraft: (minecraftDefinitions.settings as RawDefinition[]).map(definition),
  valheim: (valheimDefinitions.settings as RawDefinition[]).map(definition),
  palworld: (palworldDefinitions.settings as RawDefinition[]).map(definition),
};

export function gameSettingDefinitions(gameId: string): readonly SettingDefinition[] {
  return definitionsByGame[gameId] ?? [];
}


export type GameSettingsCheck =
  | Readonly<{ ok: true; values: Readonly<Record<string, SettingValue>> }>
  | Readonly<{ ok: false; error: "game_has_no_settings" | "invalid_game_settings" | "unknown_game_setting" | "invalid_game_setting"; setting?: string }>;

/**
 * The values a world sets, each one defined and valid. A value equal to its
 * default is kept: once a world sets a setting, the host keeps setting it, so
 * returning it to the default does not leave the old value on the server.
 */
export function checkGameSettings(gameId: string, raw: unknown): GameSettingsCheck {
  const definitions = gameSettingDefinitions(gameId);
  if (definitions.length === 0) return { ok: false, error: "game_has_no_settings" };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_game_settings" };
  const values: Record<string, SettingValue> = {};
  for (const [id, value] of Object.entries(raw)) {
    const setting = definitions.find((candidate) => candidate.id === id);
    if (setting === undefined) return { ok: false, error: "unknown_game_setting", setting: id };
    if (!settingValueValid(setting, value)) return { ok: false, error: "invalid_game_setting", setting: id };
    values[id] = value;
  }
  return { ok: true, values };
}
