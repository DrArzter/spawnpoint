import { useState } from "react";

export function Avatar({ name, photoUrl, size = "medium" }: { name: string; photoUrl?: string; size?: "small" | "medium" | "large" }) {
  const [failed, setFailed] = useState(false);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "U";
  if (photoUrl && !failed) {
    // impeccable-disable-next-line broken-image -- photoUrl is required by this branch; initials handle load failures.
    return <img alt={`${name} profile`} className={`avatar avatar-${size}`} onError={() => setFailed(true)} src={photoUrl} />;
  }
  return <span aria-hidden="true" className={`avatar avatar-${size}`}>{initials}</span>;
}
