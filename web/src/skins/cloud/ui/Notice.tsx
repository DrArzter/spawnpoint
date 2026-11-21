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

/** One line above the content: what is wrong or going on, and the one thing to do about it at the end edge. */
export function Notice({ notice }: Readonly<{ notice: NoticeModel }>) {
  const look = looks[notice.tone];
  return (
    <div className={cx("c-notice", `c-tone-${look.tone}`)} role={notice.tone === "error" ? "alert" : "status"}>
      <Icon name={look.icon} size={20} />
      <span className="c-notice-text">
        <strong>{notice.title}</strong>
        {notice.description && <span className="c-notice-detail">{notice.description}</span>}
      </span>
      {notice.action && <ActionButton action={notice.action} size="sm" />}
    </div>
  );
}

export function Notices({ notices }: Readonly<{ notices: readonly NoticeModel[] }>) {
  if (notices.length === 0) return null;
  return <div className="c-notices">{notices.map((notice) => <Notice key={notice.id} notice={notice} />)}</div>;
}
