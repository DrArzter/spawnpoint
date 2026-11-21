import type { ReactNode } from "react";

import { cx } from "../../../lib/cx";

export type CardBody = "pad" | "flush" | "kv";

/**
 * A card: its title and count at the start of the head, its actions at the
 * end. The body keeps its content at the top, so cards of one grid row share
 * one height without centring anything (R11).
 */
export function Card({ title, meta, count, titleTip, actions, body = "pad", className, label, children }: Readonly<{
  title?: string;
  /** A fact after the title on the same line: "· 3 players". */
  meta?: ReactNode;
  count?: number;
  /** A short definition of the title, shown as its tooltip. */
  titleTip?: string;
  actions?: ReactNode;
  body?: CardBody;
  className?: string;
  /** Names a card that has no visible title. */
  label?: string;
  children: ReactNode;
}>) {
  return (
    <section aria-label={title ? undefined : label} className={cx("c-card", className)}>
      {title && (
        <header className="c-card-head">
          <h2 data-tip={titleTip} tabIndex={titleTip ? 0 : undefined}>
            {title}
            {count !== undefined && <span className="c-count">{count}</span>}
          </h2>
          {meta && <span className="c-card-meta">{meta}</span>}
          {actions && <div className="c-card-actions">{actions}</div>}
        </header>
      )}
      <div className={cx("c-card-body", `c-card-body-${body}`)}>{children}</div>
    </section>
  );
}
