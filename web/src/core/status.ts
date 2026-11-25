import type { AccessInvitation } from "../api/contract";
import type { Preset, ServerState, World } from "../model";
import { onlyOlderRevisions } from "./presets";
import { t } from "../i18n";

/*
 * What a status mark says, in words every skin draws its own way: the kind
 * picks the tone and glyph, the label is the text.
 */

export type StatusKind = "ok" | "progress" | "off" | "unknown" | "ready" | "error" | "warning" | "info" | "archived" | "absent" | "pending";

export type StatusDescriptor = { kind: StatusKind; label: string };

export function sessionStatus(state: ServerState): StatusDescriptor {
  switch (state) {
    case "running": return { kind: "ok", label: t("world.online") };
    case "starting": return { kind: "progress", label: t("world.starting") };
    case "stopping": return { kind: "progress", label: t("world.stopping") };
    case "stopped": return { kind: "off", label: t("world.statusStopped") };
    default: return { kind: "unknown", label: t("common.unknown") };
  }
}

// The unlit states are drawn on purpose: Archived and Not created carry their
// own glyphs instead of an empty cell.
export function worldStatus(world: World): StatusDescriptor {
  if (world.materialization === "archived") return { kind: "archived", label: t("world.archived") };
  if (world.materialization === "not_created") return { kind: "absent", label: t("world.notCreated") };
  if (!world.sessionControlAvailable) return { kind: "warning", label: t("world.noSessionWorkflow") };
  return { kind: "ready", label: t("common.ready") };
}

export function buildStatus(status: Preset["buildStatus"]): StatusDescriptor {
  switch (status) {
    case "ready": return { kind: "ok", label: t("common.ready") };
    case "building": return { kind: "progress", label: t("world.building") };
    case "failed": return { kind: "error", label: t("world.buildFailed") };
    default: return { kind: "absent", label: t("world.notBuilt") };
  }
}

/**
 * What a preset's row says about builds. A preset whose published releases all
 * come from an older revision is ready; the build of the new revision is a
 * second, compact state beside it, never a replacement for it.
 */
export function presetBuildStates(preset: Preset): { status: StatusDescriptor; revision: StatusDescriptor | null } {
  const current = preset.build?.state === "starting" ? { kind: "pending" as const, label: t("world.awaitingDispatch") } : buildStatus(preset.buildStatus);
  if (!onlyOlderRevisions(preset)) return { status: current, revision: null };
  return { status: { kind: "ok", label: t("common.ready") }, revision: { kind: current.kind, label: t("world.newRevision", { status: current.label.charAt(0).toLowerCase() + current.label.slice(1) }) } };
}

export function hostStatus(state: "pending" | "running" | "stopping" | "stopped" | "unknown"): StatusDescriptor {
  switch (state) {
    case "running": return { kind: "ok", label: t("world.statusRunning") };
    case "pending": return { kind: "progress", label: t("common.pending") };
    case "stopping": return { kind: "progress", label: t("world.stopping") };
    case "stopped": return { kind: "off", label: t("world.statusStopped") };
    default: return { kind: "unknown", label: t("common.unknown") };
  }
}

/** An access invitation's state, the same words in every skin. */
export function invitationStatus(status: AccessInvitation["status"]): StatusDescriptor {
  switch (status) {
    case "PENDING": return { kind: "pending", label: t("common.pending") };
    case "USED": return { kind: "ok", label: t("access.used") };
    case "REVOKED": return { kind: "off", label: t("access.revoked") };
    default: return { kind: "off", label: t("access.expired") };
  }
}
