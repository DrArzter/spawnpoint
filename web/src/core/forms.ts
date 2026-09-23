import { useEffect, useState } from "react";

import type { ControlPlaneSnapshot, Game, Preset, World } from "../model";
import type { Confirmation } from "../shell/actions";
import { action } from "./actions";
import type { ConfirmationModel, ConnectionFieldsModel, CreateWorldModel, WorldPlacement, WorldSettingsModel } from "./models";

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
  const stopped = game.lifecycle === null || (game.lifecycle.activeSessionId === null && game.lifecycle.observedState === "stopped");
  return {
    game,
    world,
    stopped,
    connection,
    valid: connection.valid,
    save: action("world.settings.save", "Save settings", () => opts.onSave(connection.placement, connection.connectivity, connection.auth), { disabled: !connection.valid || !stopped || opts.busy, busy: opts.busy, hint: stopped ? undefined : "Stop this game's current session before changing hosting." }),
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
            ? `Spawnpoint will create ${world.displayName} from its ready preset, open wipe #1 and boot the shared host for ${game.displayName}. The first start may take several minutes, and the host is billed while it runs.`
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
