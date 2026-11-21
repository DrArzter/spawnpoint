import type { ReactNode } from "react";

import { Icon, IconName } from "../../icons";
import { cx } from "../../lib/cx";

export type BannerTone = "neutral" | "error";

const bannerIcon: Record<BannerTone, IconName> = { neutral: "info", error: "error" };

export function Banner({ title, description, tone = "neutral", actions }: Readonly<{ title: ReactNode; description?: ReactNode; tone?: BannerTone; actions?: ReactNode }>) {
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

export function Ghost({ children }: Readonly<{ children: ReactNode }>) {
  return <span className="ghost">{children}</span>;
}
