import type { Notice as NoticeModel } from "../../../core/models";
import { Icon, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";
import { ActionButton } from "./ActionButton";

const looks: Readonly<Record<NoticeModel["tone"], Readonly<{ tone: string; icon: IconName }>>> = {
  info: { tone: "busy", icon: "info" },
  warning: { tone: "warn", icon: "warning" },
  error: { tone: "err", icon: "error" },
  success: { tone: "ok", icon: "check_circle" },
};

/**
 * One line above the content: what is wrong or going on, and the one thing to
 * do about it at the end edge. `detail: "tooltip"` keeps the description off
 * the line and puts it on an info mark (spec §9.3: details in a tooltip).
 */
export function Notice({ notice, detail = "line" }: Readonly<{ notice: NoticeModel; detail?: "line" | "tooltip" }>) {
  const look = looks[notice.tone];
  // An error interrupts (alert); anything else is polite, which <output> is.
  const Live = notice.tone === "error" ? "div" : "output";
  return (
    <Live className={cx("c-notice", `c-tone-${look.tone}`)} role={notice.tone === "error" ? "alert" : undefined}>
      <Icon name={look.icon} size={20} />
      <span className="c-notice-text">
        <strong>{notice.title}</strong>
        {notice.description && detail === "line" && <span className="c-notice-detail">{notice.description}</span>}
        {notice.description && detail === "tooltip" && <span aria-label={notice.description} className="c-notice-more" data-tip={notice.description} role="img" tabIndex={0 /* NOSONAR focusable tooltip trigger */}><Icon name="info" size={17} /></span>}
      </span>
      {notice.action && <ActionButton action={notice.action} size="sm" />}
    </Live>
  );
}

export function Notices({ notices }: Readonly<{ notices: readonly NoticeModel[] }>) {
  if (notices.length === 0) return null;
  return <div className="c-notices">{notices.map((notice) => <Notice key={notice.id} notice={notice} />)}</div>;
}
