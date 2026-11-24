import type { Game, SettingDefinition, SettingValue, World } from "../model";
import { settingValueValid } from "../../../contract/settings";

export { settingValueValid };

/*
 * A world's game settings (ADR-0064), as the panel reads and checks them. The
 * definitions come from the API, which reads the game module's own file; the
 * API and the host check every value again.
 */

export function settingDefinitions(game: Game): readonly SettingDefinition[] {
  return game.settings ?? [];
}

/** The world can keep settings: its game defines some, and it has a record. */
export function settingsAvailable(game: Game, world: World): boolean {
  return settingDefinitions(game).length > 0 && world.gameSettings != null;
}


/** The value in effect: what the world set, else the game's default. */
export function effectiveValue(setting: SettingDefinition, world: World): SettingValue {
  const value = world.gameSettings?.values[setting.id];
  return value !== undefined && settingValueValid(setting, value) ? value : setting.default;
}

export function settingValueLabel(setting: SettingDefinition, value: SettingValue): string {
  switch (setting.type) {
    case "choice": return setting.choices.find((choice) => choice.value === value)?.label ?? String(value);
    case "boolean": return value ? "On" : "Off";
    default: return String(value);
  }
}

/** The settings whose value differs from the game's default, as "Label: value". */
export function changedSettings(game: Game, world: World): readonly string[] {
  return settingDefinitions(game)
    .filter((setting) => effectiveValue(setting, world) !== setting.default)
    .map((setting) => `${setting.label}: ${settingValueLabel(setting, effectiveValue(setting, world))}`);
}
