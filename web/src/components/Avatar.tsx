import { useState } from "react";

import { cx } from "../lib/cx";
import { t } from "../i18n";

export function Avatar({ name, photoUrl, size = "medium", className }: Readonly<{ name: string; photoUrl?: string | null; size?: "small" | "medium" | "large"; className?: string }>) {
  const [failed, setFailed] = useState(false);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "U";
  if (photoUrl && !failed) {
    // impeccable-disable-next-line broken-image -- photoUrl is required by this branch; initials handle load failures.
    return <img alt={t("profile.nameProfile", { name })} className={cx("avatar", `avatar-${size}`, className)} onError={() => setFailed(true)} src={photoUrl} />;
  }
  return <span aria-hidden="true" className={cx("avatar", `avatar-${size}`, className)}>{initials}</span>;
}
