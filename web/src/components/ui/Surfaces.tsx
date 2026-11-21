import type { ReactNode } from "react";

import { Icon, IconName } from "../../icons";
import { cx } from "../../lib/cx";

export type BannerTone = "neutral" | "error";

const bannerIcon: Record<BannerTone, IconName> = { neutral: "info", error: "error" };

export function Banner({ title, description, tone = "neutral", actions }: Readonly<{ title: ReactNode; description?: ReactNode; tone?: BannerTone; actions?: ReactNode }>) {
  // An error interrupts (alert); a neutral banner is polite, which <output> is.
  const Live = tone === "error" ? "div" : "output";
  return (
    <Live className={cx("banner", tone !== "neutral" && `banner-${tone}`)} role={tone === "error" ? "alert" : undefined}>
      <Icon name={bannerIcon[tone]} size={20} />
      <div className="banner-body">
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="banner-actions">{actions}</div>}
    </Live>
  );
}

export function Ghost({ children }: Readonly<{ children: ReactNode }>) {
  return <span className="ghost">{children}</span>;
}
