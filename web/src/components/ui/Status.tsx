import { Icon, IconName, ProgressRing } from "../../icons";
import { cx } from "../../lib/cx";
import type { Preset, ServerState, World } from "../../model";

export type StatusKind = "ok" | "progress" | "off" | "unknown" | "ready" | "error" | "warning" | "info" | "archived" | "absent" | "pending";

const icons: Record<Exclude<StatusKind, "progress">, IconName> = {
  ok: "check_circle",
  off: "stop_circle",
  unknown: "help",
  ready: "check_circle",
  error: "error",
  warning: "warning",
  info: "info",
  archived: "do_not_disturb_on",
  absent: "add_circle_outline",
  pending: "pending",
};

export function StatusIcon({ kind, size = 20 }: { kind: StatusKind; size?: number }) {
  return kind === "progress" ? <ProgressRing size={size} /> : <Icon name={icons[kind]} size={size} />;
}

export function Status({ kind, label, size = "medium", className }: { kind: StatusKind; label: string; size?: "medium" | "large"; className?: string }) {
  return (
    <span className={cx("status", `status-${kind}`, size === "large" && "status-large", className)}>
      <StatusIcon kind={kind} size={size === "large" ? 28 : 20} />
      <span>{label}</span>
    </span>
  );
}

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

export function hostStatus(state: "pending" | "running" | "stopping" | "stopped" | "unknown"): StatusDescriptor {
  switch (state) {
    case "running": return { kind: "ok", label: "Running" };
    case "pending": return { kind: "progress", label: "Pending" };
    case "stopping": return { kind: "progress", label: "Stopping" };
    case "stopped": return { kind: "off", label: "Stopped" };
    default: return { kind: "unknown", label: "Unknown" };
  }
}
