import { useState } from "react";

import { cx } from "../../../lib/cx";

export type AvatarSize = "sm" | "md" | "lg" | "xl";

export function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

/** A person's photo or initials. The name always stands beside it, so it is hidden from assistive technology. */
export function Avatar({ name, photoUrl, size = "md", tone = "person", className }: Readonly<{ name: string; photoUrl?: string | null; size?: AvatarSize; tone?: "person" | "request" | "quiet"; className?: string }>) {
  const [failed, setFailed] = useState(false);
  const classes = cx("c-avatar", `c-avatar-${size}`, tone !== "person" && `c-avatar-${tone}`, className);
  if (photoUrl && !failed) return <img alt="" className={classes} onError={() => setFailed(true)} src={photoUrl} />;
  return <span aria-hidden="true" className={classes}>{initialsOf(name)}</span>;
}
