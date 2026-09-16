import type { ReactNode } from "react";

import { Icon, IconName } from "../../icons";
import { cx } from "../../lib/cx";
import { ActionRow, IconButton } from "./Button";
import { useSnackbar } from "./Snackbar";
import { Tooltip } from "./Tooltip";

export function Card({ children, className, title, description, actions, footer, flush = false, as = "section", labelledBy }: {
  children?: ReactNode;
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  as?: "section" | "article" | "aside" | "div";
  labelledBy?: string;
}) {
  const Component = as;
  return (
    <Component aria-labelledby={labelledBy} className={cx("card", className)}>
      {(title || actions) && (
        <header className="card-header">
          <div>
            {title && <h2 id={labelledBy}>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <ActionRow>{actions}</ActionRow>}
        </header>
      )}
      {children !== undefined && <div className={cx("card-body", flush && "card-body-flush")}>{children}</div>}
      {footer && <footer className="card-footer">{footer}</footer>}
    </Component>
  );
}

export type Crumb = { label: string; href: string };

export function PageHeader({ title, description, status, actions, overflow, breadcrumb }: {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  /**
   * The overflow menu, at the far right of the title row. It belongs with the
   * name and the state rather than with the decision: when the row wraps, the
   * action takes a line of its own and this stays where it was.
   */
  overflow?: ReactNode;
  breadcrumb?: readonly Crumb[];
}) {
  return (
    <header className="page-header">
      {/* Two groups, each unbreakable: who this is, and what can be done about
          it. Four independent children wrapped one at a time and left orphans —
          a lone menu on its own line, a state under the name. */}
      <div className="page-title-row">
        <div className="page-title">
          {breadcrumb && breadcrumb.length > 0 && (
            <nav aria-label="Breadcrumb" className="breadcrumb">
              {breadcrumb.map((crumb) => (
                <a href={crumb.href} key={crumb.href}>
                  <Icon name="chevron_left" size={18} />
                  <span className="crumb-label">{crumb.label}</span>
                </a>
              ))}
            </nav>
          )}
          <h1>{title}</h1>
          {status}
        </div>
        {(actions || overflow) && (
          <div className="page-controls">
            {actions && <ActionRow>{actions}</ActionRow>}
            {overflow}
          </div>
        )}
      </div>
      {description && <p className="page-description">{description}</p>}
    </header>
  );
}

export type BannerTone = "neutral" | "info" | "warning" | "error" | "success";

const bannerIcon: Record<BannerTone, IconName> = { neutral: "info", info: "info", warning: "warning", error: "error", success: "check_circle" };

export function Banner({ title, description, tone = "neutral", actions }: { title: ReactNode; description?: ReactNode; tone?: BannerTone; actions?: ReactNode }) {
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

export function EmptyState({ icon, title, description, actions }: { icon: IconName; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <span aria-hidden="true" className="empty-icon"><Icon name={icon} size={28} /></span>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {actions && <ActionRow>{actions}</ActionRow>}
    </div>
  );
}

// `hint` carries a fact worth reading every time, such as a date. `explain`
// carries what the row means, which is worth reading once: it hides behind the
// label rather than adding a second line to every row.
// What a screen shows when the API has no route for it yet. It is not an error
// and offers no retry: nothing the reader can do will make it answer today.
//
// `inline` is the form for a screen that still has something to show — a strip
// above the content. The full state is for a container that would otherwise be
// empty, and putting it above content reads as "nothing here" over something.
export function NotConnected({ title, description, inline = false }: { title: ReactNode; description: ReactNode; inline?: boolean }) {
  // A line, not a box. A box is how a screen says the whole of it is missing;
  // this form is for a screen that still has something to show, and a banner
  // with a title and a paragraph was louder than the part it was reporting.
  if (inline) return <p className="not-connected"><Icon name="do_not_disturb_on" size={16} /><span><strong>{title}</strong> {description}</span></p>;
  // Not the three dots: they read as something in progress, which is the one
  // thing that is not happening. A closed sign says it plainly — the door is
  // shut, not that you may not pass, which is what `lock` says elsewhere.
  return <EmptyState description={description} icon="do_not_disturb_on" title={title} />;
}

export type DetailItem = { label: string; value: ReactNode; hint?: ReactNode; explain?: string; copy?: string; mono?: boolean };

// Label and value at constant scale, a hairline between rows: the detail
// list every resource page is read from.
// `flush` makes a detail list keep the rhythm of a table in the same card: the
// same left edge, the same row height. Without it a page of tables and one list
// reads as two grids that nearly line up, which is worse than two that plainly
// do not.
export function Details({ items, label, flush = false }: { items: readonly DetailItem[]; label?: string; flush?: boolean }) {
  return (
    <dl aria-label={label} className={cx("details", flush && "details-flush")}>
      {items.map((item) => (
        <div className="details-row" key={item.label}>
          <dt>
            {item.label}
            {item.explain && <Tooltip className="explain-mark" text={item.explain}><Icon name="help" size={14} /></Tooltip>}
          </dt>
          <dd>
            <span className="value-row">
              {item.mono && typeof item.value === "string" ? <code>{item.value}</code> : item.value}
              {item.copy && <CopyButton label={`Copy ${typeof item.label === "string" ? item.label.toLowerCase() : "value"}`} value={item.copy} />}
            </span>
            {item.hint && <small>{item.hint}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function DetailsGroup({ title, items }: { title: string; items: readonly DetailItem[] }) {
  return (
    <section className="details-group">
      <h3>{title}</h3>
      <Details items={items} label={title} />
    </section>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const notify = useSnackbar();
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      notify({ message: `Copied ${value}`, tone: "info" });
    } catch {
      notify({ message: "Copy failed. Select the text and copy it by hand.", tone: "error" });
    }
  }
  return <IconButton icon="content_copy" label={label} onClick={() => void copy()} size="small" />;
}

export function Ghost({ children }: { children: ReactNode }) {
  return <span className="ghost">{children}</span>;
}
