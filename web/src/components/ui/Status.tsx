import { Icon, IconName } from "../../icons";
import { cx } from "../../lib/cx";

/** The front door shows only these states (the landing page's console picture). */
export type FrontDoorStatus = "ok" | "ready";

const icons: Record<FrontDoorStatus, IconName> = { ok: "check_circle", ready: "check_circle" };

export function Status({ kind, label, size = "medium", className }: Readonly<{ kind: FrontDoorStatus; label: string; size?: "medium" | "large"; className?: string }>) {
  return (
    <span className={cx("status", `status-${kind}`, size === "large" && "status-large", className)}>
      <Icon name={icons[kind]} size={size === "large" ? 28 : 20} />
      <span>{label}</span>
    </span>
  );
}
