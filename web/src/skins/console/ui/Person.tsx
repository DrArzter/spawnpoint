import type { ReactNode } from "react";

import { Icon, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";
import { Avatar, type AvatarSize } from "./Avatar";

/** A person: avatar, name and an optional detail line (the account, with its provider's icon). */
export function Person({ name, photoUrl, detail, detailIcon, tone = "person", size = "sm", after, className }: Readonly<{
  name: string;
  photoUrl?: string | null;
  detail?: string;
  detailIcon?: IconName;
  tone?: "person" | "request" | "quiet";
  size?: AvatarSize;
  /** A chip after the name: "You", a role. */
  after?: ReactNode;
  className?: string;
}>) {
  return (
    <span className={cx("c-person", className)}>
      <Avatar name={name} photoUrl={photoUrl} size={size} tone={tone} />
      <span className="c-person-text">
        <span className="c-person-name-row">
          <span className="c-person-name" title={name}>{name}</span>
          {after}
        </span>
        {detail && (
          <span className="c-person-detail" title={detail}>
            {detailIcon && <Icon name={detailIcon} size={15} />}
            <span>{detail}</span>
          </span>
        )}
      </span>
    </span>
  );
}
