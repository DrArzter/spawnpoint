import type { ReactNode } from "react";

import { Avatar } from "../../components/Avatar";

/** The one person cell of the access tables and the whitelist: avatar, name and an optional second line. */
export function Person({ name, detail, photoUrl }: Readonly<{ name: string; detail?: ReactNode; photoUrl?: string | null }>) {
  return (
    <span className="user-cell">
      <Avatar name={name} photoUrl={photoUrl} />
      {detail ? <span><strong>{name}</strong><small>{detail}</small></span> : <strong>{name}</strong>}
    </span>
  );
}
