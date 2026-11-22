import type { Preset, ServerState, World } from "../model";
import { onlyOlderRevisions } from "./presets";

/*
 * What a status mark says, in words every skin draws its own way: the kind
 * picks the tone and glyph, the label is the text.
 */

export type StatusKind = "ok" | "progress" | "off" | "unknown" | "ready" | "error" | "warning" | "info" | "archived" | "absent" | "pending";

export type StatusDescriptor = { kind: StatusKind; label: string };

export function sessionStatus(state: ServerState): StatusDescriptor {
  switch (state) {
    case "running": return { kind: "ok", label: "Online" };
    case "starting": return { kind: "progress", label: "Starting" };
    case "stopping": return { kind: "progress", label: "Stopping" };
    case "stopped": return { kind: "off", label: "Stopped" };
    default: return { kind: "unknown", label: "Unknown" };
  }
}

// The unlit states are drawn on purpose: Archived and Not created carry their
// own glyphs instead of an empty cell.
export function worldStatus(world: World): StatusDescriptor {
  if (world.materialization === "archived") return { kind: "archived", label: "Archived" };
  if (world.materialization === "not_created") return { kind: "absent", label: "Not created" };
  if (!world.sessionControlAvailable) return { kind: "warning", label: "No session workflow" };
  return { kind: "ready", label: "Ready" };
}

export function buildStatus(status: Preset["buildStatus"]): StatusDescriptor {
  switch (status) {
    case "ready": return { kind: "ok", label: "Ready" };
    case "building": return { kind: "progress", label: "Building" };
    case "failed": return { kind: "error", label: "Build failed" };
    default: return { kind: "absent", label: "Not built" };
  }
}

/**
 * What a preset's row says about builds. A preset whose published releases all
 * come from an older revision is ready; the build of the new revision is a
 * second, compact state beside it, never a replacement for it.
 */
export function presetBuildStates(preset: Preset): { status: StatusDescriptor; revision: StatusDescriptor | null } {
  const current = preset.build?.state === "starting" ? { kind: "pending" as const, label: "Awaiting dispatch" } : buildStatus(preset.buildStatus);
  if (!onlyOlderRevisions(preset)) return { status: current, revision: null };
  return { status: { kind: "ok", label: "Ready" }, revision: { kind: current.kind, label: `New revision: ${current.label.charAt(0).toLowerCase()}${current.label.slice(1)}` } };
}

export function hostStatus(state: "pending" | "running" | "stopping" | "stopped" | "unknown"): StatusDescriptor {
  switch (state) {
    case "running": return { kind: "ok", label: "Running" };
    case "pending": return { kind: "progress", label: "Pending" };
    case "stopping": return { kind: "progress", label: "Stopping" };
    case "stopped": return { kind: "off", label: "Stopped" };
    default: return { kind: "unknown", label: "Unknown" };
  }
}
