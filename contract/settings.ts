// A world's game settings (ADR-0064): what a setting is, and when a value is
// valid for it. The API checks every value with this rule, the panel checks it
// before it sends one, and the host checks again.

export type SettingValue = string | number | boolean;

type Common = Readonly<{ id: string; label: string; hint?: string }>;

export type SettingDefinition = Common & (
  | Readonly<{ type: "choice"; default: string; choices: readonly Readonly<{ value: string; label: string }>[] }>
  | Readonly<{ type: "integer"; default: number; min: number; max: number }>
  | Readonly<{ type: "boolean"; default: boolean }>
  | Readonly<{ type: "text"; default: string; maxLength: number; pattern: string }>
);

export function settingValueValid(setting: SettingDefinition, value: unknown): value is SettingValue {
  switch (setting.type) {
    case "choice": return typeof value === "string" && setting.choices.some((choice) => choice.value === value);
    case "integer": return typeof value === "number" && Number.isInteger(value) && value >= setting.min && value <= setting.max;
    case "boolean": return typeof value === "boolean";
    case "text": return typeof value === "string" && value.length >= 1 && value.length <= setting.maxLength && new RegExp(setting.pattern).test(value);
  }
}
