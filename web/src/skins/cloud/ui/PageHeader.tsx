import type { ReactNode } from "react";

import { Icon } from "../../../icons";

export type Crumb = Readonly<{ label: string; href: string; /** The game segment, hidden where the top bar already names the game. */ game?: boolean }>;

/**
 * The page header. The breadcrumb is the title: earlier segments are quiet
 * links on the title's baseline, the last one is the h1 with its count.
 * Status and chips follow the title; actions sit at the end edge and wrap to
 * the end of a second row when space is short. On a phone the trail becomes
 * one back button.
 */
export function PageHeader({ trail = [], title, count, lead, after, actions }: Readonly<{
  trail?: readonly Crumb[];
  title: string;
  count?: number;
  lead?: ReactNode;
  after?: ReactNode;
  actions?: ReactNode;
}>) {
  const back = trail.at(-1);
  return (
    <header className="c-page-header" data-from="760" data-layout="one-line spread">
      <div className="c-page-title">
        {back && (
          <a aria-label={`Back to ${back.label}`} className="c-page-back" href={back.href}>
            <Icon name="arrow_back" size={22} />
          </a>
        )}
        {lead}
        <nav aria-label="Breadcrumb" className="c-crumbs" data-layout="crumbs">
          {trail.map((crumb) => (
            <span className={crumb.game ? "c-crumb c-crumb-game" : "c-crumb"} key={crumb.href}>
              <a href={crumb.href}>{crumb.label}</a>
              <span aria-hidden="true" className="c-crumb-sep">›</span>
            </span>
          ))}
          <h1 aria-current="page" tabIndex={-1} title={title}>
            {title}
            {count !== undefined && <span className="c-count">{count}</span>}
          </h1>
        </nav>
        {after}
      </div>
      {actions && <div className="c-page-actions">{actions}</div>}
    </header>
  );
}
