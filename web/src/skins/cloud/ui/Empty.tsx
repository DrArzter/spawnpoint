import type { ApiFailureKind } from "../../../api/contract";
import type { Action } from "../../../core/actions";
import { Icon, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";
import { ActionButton } from "./ActionButton";

/**
 * An empty or failed region: one icon, one title, at most one Action, centred
 * in its box. The error variant may add the failure's own message as one line.
 */
export function Empty({ icon, title, action, size = "md", tone = "plain", message }: Readonly<{
  icon: IconName;
  title: string;
  action?: Action | null;
  size?: "md" | "sm";
  tone?: "plain" | "error";
  message?: string;
}>) {
  return (
    <div className={cx("c-empty", size === "sm" && "c-empty-sm", tone === "error" && "c-empty-error")} role={tone === "error" ? "alert" : undefined}>
      <span aria-hidden="true" className="c-empty-icon"><Icon name={icon} size={size === "sm" ? 22 : 28} /></span>
      <strong className="c-empty-title">{title}</strong>
      {message && message !== title && <span className="c-empty-message">{message}</span>}
      {action && <ActionButton action={action} size="sm" />}
    </div>
  );
}

/**
 * A failed Loading value: Retry unless the role is the reason. `forbidden`
 * reads "Your role cannot <verb>" and offers nothing to press.
 */
export function LoadError({ title, verb, error, kind, retry, size = "md" }: Readonly<{ title: string; verb: string; error: string; kind: ApiFailureKind; retry: Action; size?: "md" | "sm" }>) {
  if (kind === "forbidden") return <Empty icon="lock" size={size} title={`Your role cannot ${verb}`} />;
  return <Empty action={retry} icon={kind === "unavailable" ? "cloud_off" : "error"} message={error} size={size} title={title} tone="error" />;
}
