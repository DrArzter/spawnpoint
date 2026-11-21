import { useEffect, useRef } from "react";

import type { StatusDescriptor, StatusKind } from "../../../core/status";
import { Icon, ProgressRing, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";

export type StatusTone = "ok" | "warn" | "err" | "busy" | "off";

const looks: Readonly<Record<StatusKind, Readonly<{ tone: StatusTone; icon: IconName | "spinner" }>>> = {
  ok: { tone: "ok", icon: "check_circle" },
  ready: { tone: "ok", icon: "check_circle" },
  progress: { tone: "busy", icon: "spinner" },
  pending: { tone: "busy", icon: "pending" },
  off: { tone: "off", icon: "stop_circle" },
  archived: { tone: "off", icon: "inventory_2" },
  absent: { tone: "off", icon: "radio_button_unchecked" },
  unknown: { tone: "warn", icon: "help" },
  warning: { tone: "warn", icon: "warning" },
  error: { tone: "err", icon: "error" },
  info: { tone: "busy", icon: "info" },
};

export function statusTone(kind: StatusKind): StatusTone {
  return looks[kind].tone;
}

export function StatusIcon({ kind, size = 18 }: Readonly<{ kind: StatusKind; size?: number }>) {
  const icon = looks[kind].icon;
  return icon === "spinner" ? <ProgressRing className="c-spin" size={size} /> : <Icon name={icon} size={size} />;
}

// Whether this status differs from what the same mark showed last render (A7).
function useChanged(status: StatusDescriptor): boolean {
  const last = useRef(status);
  const changed = last.current.kind !== status.kind || last.current.label !== status.label;
  useEffect(() => { last.current = status; });
  return changed;
}

/** A state as an icon and its word in the state's tone; never colour alone. */
export function Status({ status, variant = "text", className }: Readonly<{ status: StatusDescriptor; variant?: "text" | "pill"; className?: string }>) {
  const changed = useChanged(status);
  const tone = statusTone(status.kind);
  return (
    <span className={cx("c-status", `c-status-${variant}`, `c-tone-${tone}`, className)} data-status={status.kind}>
      <span className={cx("c-status-mark", changed && "c-status-changed")} key={`${status.kind}:${status.label}`}>
        <StatusIcon kind={status.kind} size={variant === "pill" ? 17 : 18} />
        <span className="c-status-label">{status.label}</span>
      </span>
    </span>
  );
}
