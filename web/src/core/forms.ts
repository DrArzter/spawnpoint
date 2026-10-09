import { useEffect, useState } from "react";

import type { ControlPlaneSnapshot, Game, Preset, SettingDefinition, SettingValue, World } from "../model";
import { worldSessionActive } from "../session";
import type { Confirmation } from "../shell/actions";
import { action } from "./actions";
import type { ConfirmationModel, ConnectionFieldsModel, CreateWorldModel, GameSettingField, GameSettingsModel, WorldPlacement, WorldSettingsModel } from "./models";
import { effectiveValue, settingDefinitions, settingValueValid } from "./settings";

/*
 * The forms the console opens over a page. Their drafts live here so a skin
 * only draws fields and calls setters; validity, defaults and what counts as
 * a fleet-capable deployment are decided once.
 */

type Deployment = ControlPlaneSnapshot["deployment"];

// A fleet host never joins ZeroTier; the configured host offers nothing else.
function defaultConnectivity(placement: WorldPlacement, dnsAvailable: boolean): World["connectivity"] {
  if (placement === "configured") return "zerotier";
  return dnsAvailable ? "route53" : "raw";
}

function useConnectionFields(deployment: Deployment, initial: { placement: WorldPlacement; connectivity: World["connectivity"] }): ConnectionFieldsModel & { valid: boolean; auth: "game" | undefined } {
  const [placement, setPlacement] = useState<WorldPlacement>(initial.placement);
  const [connectivity, setConnectivity] = useState<World["connectivity"]>(initial.connectivity);
  const fleetAvailable = deployment?.launchEnabled === true;
  const dnsAvailable = deployment?.dnsAvailable === true;
  const valid = placement === "configured"
    ? connectivity === "zerotier"
    : fleetAvailable && (connectivity === "raw" || (connectivity === "route53" && dnsAvailable));
  return {
    placement,
    // Changing where a world runs changes how it is reached: a fleet host never
    // joins ZeroTier, the configured host offers nothing else.
    setPlacement: (next) => { setPlacement(next); setConnectivity(defaultConnectivity(next, dnsAvailable)); },
    fleetAvailable,
    connectivity,
    setConnectivity,
    dnsAvailable,
    valid,
    auth: connectivity === "zerotier" ? undefined : "game",
  };
}

export function useCreateWorldForm(game: Game, initialPreset: Preset | null, deployment: Deployment, opts: Readonly<{ busy: boolean; onCreate: (preset: Preset, name: string, release: string, placement: WorldPlacement, connectivity: World["connectivity"], auth?: "game") => void; onClose: () => void }>): CreateWorldModel {
  const firstReady = game.presets.find((preset) => preset.buildStatus === "ready");
  const [presetId, setPresetId] = useState(initialPreset?.id ?? firstReady?.id ?? "");
  const preset = game.presets.find((item) => item.id === presetId) ?? null;
  const [name, setName] = useState("");
  const [release, setRelease] = useState(preset?.latestRelease ?? "");
  const connection = useConnectionFields(deployment, deployment?.placement === "fleet" && deployment.launchEnabled
    ? { placement: "fleet", connectivity: deployment.dnsAvailable ? "route53" : "raw" }
    : { placement: "configured", connectivity: "zerotier" });
  useEffect(() => setRelease(preset?.latestRelease ?? ""), [preset?.id, preset?.latestRelease]);
  const valid = preset !== null && preset.buildStatus === "ready" && preset.releases.includes(release) && name.trim().length > 0 && name.trim().length <= 80 && connection.valid;
  return {
    game,
    presets: game.presets,
    presetId,
    setPresetId,
    preset,
    name,
    setName,
    release,
    setRelease,
    connection,
    valid,
    submit: action("world.create", "Create world", () => { if (preset && valid) opts.onCreate(preset, name.trim(), release, connection.placement, connection.connectivity, connection.auth); }, { icon: "add", disabled: !valid || opts.busy, busy: opts.busy }),
    cancel: action("sheet.close", "Close panel", opts.onClose),
  };
}

export function useWorldSettingsForm(game: Game, world: World, deployment: Deployment, opts: Readonly<{ busy: boolean; onSave: (placement: WorldPlacement, connectivity: World["connectivity"], auth?: "game") => void; onClose: () => void }>): WorldSettingsModel {
  const connection = useConnectionFields(deployment, { placement: world.placement ?? (world.connectivity === "zerotier" ? "configured" : "fleet"), connectivity: world.connectivity });
  // Only this world's own session holds its hosting back (ADR-0062).
  const stopped = !worldSessionActive(game, world);
  return {
    game,
    world,
    stopped,
    connection,
    valid: connection.valid,
    save: action("world.settings.save", "Save settings", () => opts.onSave(connection.placement, connection.connectivity, connection.auth), { disabled: !connection.valid || !stopped || opts.busy, busy: opts.busy, hint: stopped ? undefined : "Stop this world's session before changing hosting." }),
    cancel: action("sheet.close", "Cancel", opts.onClose, { disabled: opts.busy }),
  };
}

// A draft is what a field holds: text for numbers and words, a flag for a switch.
export type SettingDraft = string | boolean;

function draftOf(setting: SettingDefinition, value: SettingValue): SettingDraft {
  return setting.type === "boolean" ? value === true : String(value);
}

// The value a draft stands for, or undefined when the game would not accept it.
function parsedValue(setting: SettingDefinition, draft: SettingDraft): SettingValue | undefined {
  const value: SettingValue = setting.type === "boolean" ? draft === true
    : setting.type === "integer" ? (typeof draft === "string" && /^-?[0-9]+$/.test(draft.trim()) ? Number(draft.trim()) : Number.NaN)
      : String(draft);
  return settingValueValid(setting, value) ? value : undefined;
}

function fieldError(setting: SettingDefinition, draft: SettingDraft): string | null {
  if (parsedValue(setting, draft) !== undefined) return null;
  if (setting.type === "integer") return `A whole number from ${setting.min} to ${setting.max}.`;
  if (setting.type === "text") return String(draft).length === 0 ? "Required." : `Up to ${setting.maxLength} characters, and only the ones listed.`;
  return "Not a value this game accepts.";
}

/**
 * What a save of the game settings sends (ADR-0064). A setting the world has
 * set stays set, so putting it back to its default still reaches the server;
 * one it never set is left out, so the server keeps what it had.
 */
export function gameSettingsPayload(
  definitions: readonly SettingDefinition[],
  stored: Readonly<Record<string, SettingValue>>,
  drafts: Readonly<Record<string, SettingDraft>>,
): Readonly<{ values: Readonly<Record<string, SettingValue>>; valid: boolean; changed: boolean; atDefaults: boolean }> {
  const parsed = definitions.map((setting) => ({ setting, value: parsedValue(setting, drafts[setting.id] ?? draftOf(setting, setting.default)) }));
  const values: Record<string, SettingValue> = {};
  for (const { setting, value } of parsed) {
    if (value !== undefined && (Object.hasOwn(stored, setting.id) || value !== setting.default)) values[setting.id] = value;
  }
  return {
    values,
    valid: parsed.every(({ value }) => value !== undefined),
    changed: Object.keys(values).length !== Object.keys(stored).length || Object.entries(values).some(([id, value]) => stored[id] !== value),
    atDefaults: parsed.every(({ setting, value }) => value === setting.default),
  };
}

export function useGameSettingsForm(game: Game, world: World, opts: Readonly<{ busy: boolean; onSave: (values: Readonly<Record<string, SettingValue>>) => void; onClose: () => void }>): GameSettingsModel {
  const definitions = settingDefinitions(game);
  const [drafts, setDrafts] = useState<Record<string, SettingDraft>>(() => Object.fromEntries(definitions.map((setting) => [setting.id, draftOf(setting, effectiveValue(setting, world))])));
  const stored = world.gameSettings?.values ?? {};
  const set = (id: string, value: SettingDraft) => setDrafts((current) => ({ ...current, [id]: value }));
  const draftFor = (setting: SettingDefinition) => drafts[setting.id] ?? draftOf(setting, setting.default);
  const { values, valid, changed, atDefaults } = gameSettingsPayload(definitions, stored, drafts);

  const fields = definitions.map((setting): GameSettingField => {
    const base = { id: setting.id, label: setting.label, ...(setting.hint ? { hint: setting.hint } : {}) };
    const draft = draftFor(setting);
    switch (setting.type) {
      case "choice": return { ...base, kind: "choice", value: String(draft), options: setting.choices, set: (value) => set(setting.id, value) };
      case "integer": return { ...base, kind: "number", value: String(draft), min: setting.min, max: setting.max, set: (value) => set(setting.id, value), error: fieldError(setting, draft) };
      case "text": return { ...base, kind: "text", value: String(draft), maxLength: setting.maxLength, set: (value) => set(setting.id, value), error: fieldError(setting, draft) };
      case "boolean": return { ...base, kind: "toggle", checked: draft === true, toggle: action(`game-settings.${setting.id}`, setting.label, () => set(setting.id, draft !== true), { disabled: opts.busy }) };
    }
  });

  return {
    game,
    world,
    running: worldSessionActive(game, world),
    fields,
    save: action("game-settings.save", "Save settings", () => { if (valid && changed) opts.onSave(values); }, {
      disabled: !valid || !changed || opts.busy,
      busy: opts.busy,
      hint: !valid ? "Correct the marked settings first." : !changed ? "Nothing has changed." : undefined,
    }),
    restoreDefaults: action("game-settings.defaults", "Restore defaults", () => setDrafts(Object.fromEntries(definitions.map((setting) => [setting.id, draftOf(setting, setting.default)]))), { disabled: atDefaults || opts.busy }),
    cancel: action("sheet.close", "Cancel", opts.onClose, { disabled: opts.busy }),
  };
}

function confirmationCopy(confirmation: Confirmation): { title: string; description: string; label: string; destructive: boolean } {
  const { world, game } = confirmation;
  switch (confirmation.kind) {
    case "session":
      return confirmation.action === "start"
        ? {
          title: "Start a billed AWS session?",
          description: world.materialization === "not_created"
            ? `Spawnpoint will create ${world.displayName} from its ready preset, open wipe #1 and ${world.placement === "fleet" ? "launch a fleet host for it" : `boot the shared host for ${game.displayName}`}. The first start may take several minutes, and the host is billed while it runs.`
            : world.placement === "fleet"
              ? `Spawnpoint will launch a fleet host for ${world.displayName}, or reuse one with room. Other worlds keep running. ${game.displayName} may take several minutes to become healthy, and the host is billed while it runs.`
              : `Spawnpoint will boot the shared host and start ${world.displayName}. ${game.displayName} may take several minutes to become healthy, and the host is billed while it runs.`,
          label: "Start session",
          destructive: false,
        }
        : { title: "Save, back up and stop this session?", description: "Spawnpoint refuses while players are online, then saves the world, takes a verified backup and stops the host.", label: "Stop session", destructive: true };
    case "archive":
      return { title: `Archive ${world.displayName}?`, description: "Spawnpoint will safely stop and back up an active session, then hide this world from session control. Its wipes and backups stay intact.", label: "Archive world", destructive: false };
    case "wipe":
      return { title: `Start a new wipe of ${world.displayName}?`, description: `Spawnpoint will safely stop and back up the current wipe, close it, and open an empty wipe from the selected ${confirmation.preset?.displayName ?? "preset"} release.`, label: "Start new wipe", destructive: true };
    case "purge":
      return { title: `Permanently delete ${world.displayName}?`, description: "This deletes the world registry, the release pointer and every version of every S3 backup. It cannot be undone from the console.", label: "Delete forever", destructive: true };
    default:
      return { title: `Restore ${confirmation.backupName}?`, description: `Spawnpoint will safely stop and back up the current wipe, then restore ${confirmation.backupName} as a new wipe.`, label: "Restore backup", destructive: true };
  }
}

export function useConfirmationForm(confirmation: Confirmation | null, opts: Readonly<{ onConfirm: (confirmation: Confirmation, release?: string) => void; onClose: () => void }>): ConfirmationModel | null {
  const [typed, setTyped] = useState("");
  const [release, setRelease] = useState("");
  useEffect(() => {
    setTyped("");
    setRelease(confirmation?.kind === "wipe" ? confirmation.preset?.latestRelease ?? "" : "");
  }, [confirmation]);
  if (confirmation === null) return null;
  const copy = confirmationCopy(confirmation);
  const preset = confirmation.kind === "wipe" ? confirmation.preset : null;
  const blocked = (confirmation.kind === "purge" && typed !== confirmation.world.id) || (confirmation.kind === "wipe" && !(preset?.releases.includes(release) ?? false));
  return {
    title: copy.title,
    description: copy.description,
    destructive: copy.destructive,
    confirm: action("confirm", copy.label, () => opts.onConfirm(confirmation, confirmation.kind === "wipe" ? release : undefined), { disabled: blocked, danger: copy.destructive }),
    cancel: action("cancel", "Cancel", opts.onClose),
    releaseChoice: preset ? { value: release, options: [...preset.releases].reverse().map((version) => ({ version, latest: version === preset.latestRelease })), set: setRelease } : null,
    typedConfirmation: confirmation.kind === "purge" ? { expected: confirmation.world.id, value: typed, set: setTyped } : null,
  };
}
