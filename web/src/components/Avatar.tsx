import { useState } from "react";

import { cx } from "../lib/cx";

export function Avatar({ name, photoUrl, size = "medium", className }: { name: string; photoUrl?: string | null; size?: "small" | "medium" | "large"; className?: string }) {
  const [failed, setFailed] = useState(false);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "U";
  if (photoUrl && !failed) {
    // impeccable-disable-next-line broken-image -- photoUrl is required by this branch; initials handle load failures.
    return <img alt={`${name} profile`} className={cx("avatar", `avatar-${size}`, className)} onError={() => setFailed(true)} src={photoUrl} />;
  }
  return <span aria-hidden="true" className={cx("avatar", `avatar-${size}`, className)}>{initials}</span>;
}
