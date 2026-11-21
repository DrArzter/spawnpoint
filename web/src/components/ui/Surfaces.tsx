import type { ReactNode } from "react";

import { Icon, IconName } from "../../icons";
import { cx } from "../../lib/cx";

export type BannerTone = "neutral" | "info" | "warning" | "error" | "success";

const bannerIcon: Record<BannerTone, IconName> = { neutral: "info", info: "info", warning: "warning", error: "error", success: "check_circle" };

export function Banner({ title, description, tone = "neutral", actions }: { title: ReactNode; description?: ReactNode; tone?: BannerTone; actions?: ReactNode }) {
  return (
    <div className={cx("banner", tone !== "neutral" && `banner-${tone}`)} role={tone === "error" ? "alert" : "status"}>
      <Icon name={bannerIcon[tone]} size={20} />
      <div className="banner-body">
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="banner-actions">{actions}</div>}
    </div>
  );
}

export function Ghost({ children }: { children: ReactNode }) {
  return <span className="ghost">{children}</span>;
}
