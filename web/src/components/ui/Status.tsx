import { Icon, IconName, ProgressRing } from "../../icons";
import { cx } from "../../lib/cx";
import type { StatusKind } from "../../core/status";

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
