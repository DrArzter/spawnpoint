import { useEffect, useState } from "react";

import type { ControlPlaneSnapshot, Game, Preset, SettingDefinition, SettingValue, World } from "../model";
import { worldSessionActive } from "../session";
import type { Confirmation } from "../shell/actions";
import { action } from "./actions";
import { startableLatest, startableReleases } from "./presets";
import { releaseBuildCopy } from "./release-builds";
import { connectionLabel, neverStarted, promotionTargets } from "./worlds";
import type { ConfirmationModel, ConnectionFieldsModel, ConnectionOption, CreateWorldModel, GameSettingField, GameSettingsModel, WorldPlacement, WorldSettingsModel } from "./models";
import { effectiveValue, settingDefinitions, settingValueValid } from "./settings";

/*
 * The forms the console opens over a page. Their drafts live here so a skin
 * only draws fields and calls setters; validity, defaults and what counts as
 * a fleet-capable deployment are decided once.
 */

type Deployment = ControlPlaneSnapshot["deployment"] | undefined;

// A fleet host never joins ZeroTier (ADR-0033); the persistent host serves
// any connection (ADR-0085). A public world needs a DNS zone only for DNS.
function defaultConnectivity(placement: WorldPlacement, dnsAvailable: boolean): World["connectivity"] {
  if (placement === "configured") return "zerotier";
  return dnsAvailable ? "route53" : "raw";
}

function offered(placement: WorldPlacement, connectivity: World["connectivity"], dnsAvailable: boolean): boolean {
  if (connectivity === "zerotier") return placement === "configured";
  return connectivity === "raw" || dnsAvailable;
}

export function connectionOptions(placement: WorldPlacement, dnsAvailable: boolean): readonly ConnectionOption[] {
  return [
    { value: "zerotier", label: connectionLabel("zerotier"), disabled: placement === "fleet", ...(placement === "fleet" ? { hint: "Fleet hosts do not join ZeroTier" } : {}) },
    { value: "raw", label: connectionLabel("raw"), disabled: false },
    ...(dnsAvailable ? [{ value: "route53" as const, label: connectionLabel("route53"), disabled: false }] : []),
  ];
}

function useConnectionFields(deployment: Deployment, initial: { placement: WorldPlacement; connectivity: World["connectivity"] }): ConnectionFieldsModel & { valid: boolean; auth: "game" | undefined } {
  const [placement, setPlacement] = useState<WorldPlacement>(initial.placement);
  const [connectivity, setConnectivity] = useState<World["connectivity"]>(initial.connectivity);
  const fleetAvailable = deployment?.launchEnabled === true;
  const dnsAvailable = deployment?.dnsAvailable === true;
  const valid = offered(placement, connectivity, dnsAvailable) && (placement === "configured" || fleetAvailable);
  return {
    placement,
    // A connection the new placement does not offer falls back to its default.
    setPlacement: (next) => { setPlacement(next); if (!offered(next, connectivity, dnsAvailable)) setConnectivity(defaultConnectivity(next, dnsAvailable)); },
    fleetAvailable,
    connectivity,
    setConnectivity,
    dnsAvailable,
    connections: connectionOptions(placement, dnsAvailable),
    valid,
    auth: connectivity === "zerotier" ? undefined : "game",
  };
}

export function useCreateWorldForm(game: Game, initialPreset: Preset | null, deployment: Deployment, opts: Readonly<{ busy: boolean; onCreate: (preset: Preset, name: string, release: string, placement: WorldPlacement, connectivity: World["connectivity"], auth?: "game") => void; onClose: () => void }>): CreateWorldModel {
  const firstReady = game.presets.find((preset) => startableReleases(preset).length > 0);
  const [presetId, setPresetId] = useState(initialPreset?.id ?? firstReady?.id ?? "");
  const preset = game.presets.find((item) => item.id === presetId) ?? null;
  const [name, setName] = useState("");
  const [release, setRelease] = useState(preset ? startableLatest(preset) ?? "" : "");
  const connection = useConnectionFields(deployment, deployment?.placement === "fleet" && deployment.launchEnabled
    ? { placement: "fleet", connectivity: deployment.dnsAvailable ? "route53" : "raw" }
    : { placement: "configured", connectivity: "zerotier" });
  useEffect(() => setRelease(preset ? startableLatest(preset) ?? "" : ""), [preset?.id, preset?.latestRelease, preset?.olderReleases]);
  const valid = preset !== null && startableReleases(preset).includes(release) && name.trim().length > 0 && name.trim().length <= 80 && connection.valid;
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

function draftValue(setting: SettingDefinition, draft: SettingDraft): SettingValue {
  if (setting.type === "boolean") return draft === true;
  if (setting.type !== "integer") return String(draft);
  const text = typeof draft === "string" ? draft.trim() : "";
  return /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
}

// The value a draft stands for, or undefined when the game would not accept it.
function parsedValue(setting: SettingDefinition, draft: SettingDraft): SettingValue | undefined {
  const value = draftValue(setting, draft);
  return settingValueValid(setting, value) ? value : undefined;
}

function saveHint(valid: boolean, changed: boolean): string | undefined {
  if (!valid) return "Correct the marked settings first.";
  return changed ? undefined : "Nothing has changed.";
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
  const stored = world.gameSettings.values;
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
      hint: saveHint(valid, changed),
    }),
    restoreDefaults: action("game-settings.defaults", "Restore defaults", () => setDrafts(Object.fromEntries(definitions.map((setting) => [setting.id, draftOf(setting, setting.default)]))), { disabled: atDefaults || opts.busy }),
    cancel: action("sheet.close", "Cancel", opts.onClose, { disabled: opts.busy }),
  };
}

// What a start does, in one line: a first start also creates the world.
function startDescription(world: World): string {
  return world.materialization === "not_created" ? "Creates wipe #1 and starts a billed host." : "Starts a billed host. It may take a few minutes.";
}

function playerCount(count: number): string {
  return count === 1 ? "1 player" : `${count} players`;
}

export function confirmationCopy(confirmation: Confirmation): { title: string; description: string; label: string; destructive: boolean } {
  if (confirmation.kind === "build") {
    return { ...releaseBuildCopy(confirmation.preset), destructive: false };
  }
  const { world } = confirmation;
  switch (confirmation.kind) {
    case "session":
      return confirmation.action === "start"
        ? {
          title: "Start a billed AWS session?",
          description: startDescription(world),
          label: "Start session",
          destructive: false,
        }
        : confirmation.disconnect !== undefined
          ? {
            title: `Disconnect ${playerCount(confirmation.disconnect)} and stop?`,
            description: "Disconnects them, saves and backs up, then stops the host.",
            label: "Disconnect and stop",
            destructive: true,
          }
          : { title: "Save, back up and stop this session?", description: "Saves and backs up, then stops the host. Refused while players are online.", label: "Stop session", destructive: true };
    case "archive":
      return { title: `Archive ${world.displayName}?`, description: "Stops and backs up, then hides it from session control. Wipes and backups stay.", label: "Archive world", destructive: false };
    case "wipe":
      return { title: `Start a new wipe of ${world.displayName}?`, description: "Backs up and closes the current wipe, then opens an empty one from the chosen release.", label: "Start new wipe", destructive: true };
    case "purge":
      return { title: `Permanently delete ${world.displayName}?`, description: "Deletes the world, its release pointer and every backup. This cannot be undone.", label: "Delete forever", destructive: true };
    case "promote":
      if (neverStarted(world)) {
        return {
          title: `Update ${world.displayName} to another release?`,
          description: "Switches the release before the first start. Nothing is started or backed up.",
          label: "Update release",
          destructive: false,
        };
      }
      return {
        title: `Update ${world.displayName} to another release?`,
        description: `Keeps the save. Stops the world, keeps its backup, then starts it on the chosen release and leaves it running. If that start fails, ${world.release.activeRelease ?? "the active release"} stays. Refused while players are online.`,
        label: "Update release",
        destructive: true,
      };
    default:
      return {
        title: `Restore ${confirmation.backupName}?`,
        description: confirmation.release === null
          ? "Backs up the current wipe, then restores this backup as a new wipe."
          : `Backs up the current wipe, then restores this backup as a new wipe on release ${confirmation.release}, the release it ran.`,
        label: "Restore backup",
        destructive: true,
      };
  }
}

export function useConfirmationForm(confirmation: Confirmation | null, opts: Readonly<{ onConfirm: (confirmation: Confirmation, release?: string) => void; onClose: () => void }>): ConfirmationModel | null {
  const [typed, setTyped] = useState("");
  const [release, setRelease] = useState("");
  useEffect(() => {
    setTyped("");
    setRelease(initialRelease(confirmation));
  }, [confirmation]);
  if (confirmation === null) return null;
  const copy = confirmationCopy(confirmation);
  const options = releaseOptions(confirmation);
  // A wipe that never started holds no save, so its release change needs no typed ID.
  const typedTarget = confirmation.kind === "purge" || (confirmation.kind === "promote" && !neverStarted(confirmation.world)) ? confirmation.world.id : null;
  const needsRelease = confirmation.kind === "wipe" || confirmation.kind === "promote";
  const blocked = (typedTarget !== null && typed !== typedTarget) || (needsRelease && !(options?.some((option) => option.version === release) ?? false));
  const chosen = needsRelease ? release : undefined;
  return {
    title: copy.title,
    description: copy.description,
    destructive: copy.destructive,
    confirm: action("confirm", copy.label, () => opts.onConfirm(confirmation, chosen), { disabled: blocked, danger: copy.destructive }),
    cancel: action("cancel", "Cancel", opts.onClose),
    releaseChoice: options === null ? null : {
      label: confirmation.kind === "promote" ? "Release to update to" : "Release for the new wipe", value: release, options, set: setRelease,
    },
    typedConfirmation: typedTarget === null ? null : { label: "World ID", expected: typedTarget, value: typed, set: setTyped },
  };
}

// A wipe may open on any release of the current revision; a promotion moves to one the wipe does not run.
function releaseOptions(confirmation: Confirmation): readonly Readonly<{ version: string; latest: boolean }>[] | null {
  if (confirmation.kind !== "wipe" && confirmation.kind !== "promote") return null;
  const preset = confirmation.preset;
  if (!preset) return null;
  const releases = confirmation.kind === "promote"
    ? promotionTargets(confirmation.game, confirmation.world)
    : [...startableReleases(preset)].reverse();
  const newest = newestRelease(confirmation, preset);
  return releases.map((version) => ({ version, latest: version === newest }));
}

// A wipe opens on the current revision, and so does a wipe that never started; a promotion may go to the newest of all.
function newestRelease(confirmation: Extract<Confirmation, { kind: "wipe" | "promote" }>, preset: Preset): string | null {
  return confirmation.kind === "promote" && !neverStarted(confirmation.world) ? preset.latestRelease : startableLatest(preset);
}

function initialRelease(confirmation: Confirmation | null): string {
  if (confirmation === null || (confirmation.kind !== "wipe" && confirmation.kind !== "promote") || !confirmation.preset) return "";
  const latest = newestRelease(confirmation, confirmation.preset) ?? "";
  return releaseOptions(confirmation)?.some((option) => option.version === latest) ? latest : "";
}
