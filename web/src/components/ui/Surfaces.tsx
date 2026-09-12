import type { ReactNode } from "react";

import { Icon, IconName } from "../../icons";
import { cx } from "../../lib/cx";
import { IconButton } from "./Button";
import { useSnackbar } from "./Snackbar";

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
          {actions && <div className="btn-row">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className={cx("card-body", flush && "card-body-flush")}>{children}</div>}
      {footer && <footer className="card-footer">{footer}</footer>}
    </Component>
  );
}

export type Crumb = { label: string; href: string };

export function PageHeader({ title, description, status, actions, breadcrumb }: {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: readonly Crumb[];
}) {
  return (
    <header className="page-header">
      {breadcrumb && breadcrumb.length > 0 && (
        <nav aria-label="Breadcrumb" className="breadcrumb">
          {breadcrumb.map((crumb) => (
            <a href={crumb.href} key={crumb.href}>
              <Icon name="chevron_left" size={18} />
              {crumb.label}
            </a>
          ))}
        </nav>
      )}
      <div className="page-title-row">
        <div className="page-title">
          <h1>{title}</h1>
          {status}
        </div>
        {actions && <div className="btn-row">{actions}</div>}
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
      {actions && <div className="btn-row">{actions}</div>}
    </div>
  );
}

export type DetailItem = { label: string; value: ReactNode; hint?: ReactNode; copy?: string; mono?: boolean };

// Label and value at constant scale, a hairline between rows: the detail
// list every resource page is read from.
export function Details({ items, label }: { items: readonly DetailItem[]; label?: string }) {
  return (
    <dl aria-label={label} className="details">
      {items.map((item) => (
        <div className="details-row" key={item.label}>
          <dt>{item.label}</dt>
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
