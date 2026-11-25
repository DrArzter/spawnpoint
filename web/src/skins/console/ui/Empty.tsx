import type { ApiFailureKind } from "../../../api/contract";
import type { Action } from "../../../core/actions";
import { failureView } from "../../../core/failure";
import type { WorldsModel } from "../../../core/models";
import { Icon, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";
import { ActionButton } from "./ActionButton";
import { t } from "../../../i18n";

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
    <div className={cx("c-empty", size === "sm" && "c-empty-sm", tone === "error" && "c-empty-error")} data-layout="centred" role={tone === "error" ? "alert" : undefined}>
      <span aria-hidden="true" className="c-empty-icon"><Icon name={icon} size={size === "sm" ? 22 : 28} /></span>
      <strong className="c-empty-title">{title}</strong>
      {message && message !== title && <span className="c-empty-message">{message}</span>}
      {action && <ActionButton action={action} size="sm" />}
    </div>
  );
}

/**
 * A failed Loading value, worded by core/failure.ts: a role that lacks the
 * permission reads "Your role cannot <verb>" and offers nothing to press;
 * anything else keeps Retry.
 */
export function LoadError({ title, verb, error, kind, retry, size = "md" }: Readonly<{ title: string; verb: string; error: string; kind: ApiFailureKind; retry: Action; size?: "md" | "sm" }>) {
  const view = failureView(kind, title, verb, error);
  if (view.kind === "forbidden") return <Empty icon="lock" size={size} title={view.title} />;
  return <Empty action={view.retry ? retry : null} icon={view.kind === "unavailable" ? "cloud_off" : "error"} message={view.message ?? undefined} size={size} title={view.title} tone="error" />;
}

/** Why no game is listed: none declared, or the read failed (a role without the permission gets a lock and no Retry). */
export function GamesEmpty({ unavailable, refresh }: Readonly<{ unavailable: NonNullable<WorldsModel["unavailable"]>; refresh: Action }>) {
  if (!unavailable.failed) return <Empty icon="public" message={unavailable.description} title={t("common.noGamesYet")} />;
  return <Empty action={unavailable.retry ? refresh : null} icon={unavailable.retry ? "error" : "lock"} message={unavailable.description} title={unavailable.title} tone="error" />;
}
