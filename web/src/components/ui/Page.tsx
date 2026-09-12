import type { HTMLAttributes, ReactNode } from "react";

import { Icon, type IconName } from "../../Icon";
import { Button } from "./Button";

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <header className="ui-page-header"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="ui-page-actions">{actions}</div>}</header>;
}

export function SectionHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <header className="ui-section-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{actions && <div className="ui-section-actions">{actions}</div>}</header>;
}

export function Surface({ children, className = "", as = "section", ...props }: HTMLAttributes<HTMLElement> & { as?: "section" | "article" | "aside" }) {
  const Component = as;
  return <Component className={`ui-surface ${className}`.trim()} {...props}>{children}</Component>;
}

export function StatusBadge({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "info" | "success" | "warning" | "danger" }) {
  return <span className={`ui-status ui-status-${tone}`}><i aria-hidden="true" />{label}</span>;
}

export function EmptyState({ title, description, icon, action, busy = false }: { title: string; description: string; icon?: IconName; action?: ReactNode; busy?: boolean }) {
  return <div aria-busy={busy} className="ui-empty"><span className="ui-empty-icon" aria-hidden="true">{icon && <Icon name={icon} />}</span><div><strong>{title}</strong><p>{description}</p></div>{action}</div>;
}

export function LoadingState({ label, variant = "page" }: { label: string; variant?: "page" | "table" | "settings" | "list" }) {
  const rows = variant === "list" ? 3 : 4;
  return <div aria-busy="true" aria-live="polite" className={`ui-loading ui-loading-${variant}`} role="status">
    <span className="visually-hidden">{label}</span>
    {variant === "page" && <>
      <div aria-hidden="true" className="ui-loading-heading"><i /><i /></div>
      <div aria-hidden="true" className="ui-loading-feature"><span /><div><i /><i /></div><b /></div>
      <div aria-hidden="true" className="ui-loading-stats">{Array.from({ length: 4 }, (_, index) => <span key={index}><i /><b /><i /></span>)}</div>
      <div aria-hidden="true" className="ui-loading-section-title"><i /><i /></div>
    </>}
    {variant === "settings" && <div aria-hidden="true" className="ui-loading-section-title"><i /><i /></div>}
    {variant !== "page" && <div aria-hidden="true" className="ui-loading-bar" />}
    <div aria-hidden="true" className="ui-loading-rows">
      {Array.from({ length: rows }, (_, index) => <span key={index}><i /><i /><i /></span>)}
    </div>
  </div>;
}

export function Notice({ title, description, tone = "info", action }: { title: string; description?: string; tone?: "info" | "success" | "warning" | "danger"; action?: ReactNode }) {
  return <div className={`ui-notice ui-notice-${tone}`} role={tone === "danger" ? "alert" : "status"}><div><strong>{title}</strong>{description && <p>{description}</p>}</div>{action}</div>;
}

export function Switch({ checked, disabled = false, label, note, onChange }: { checked: boolean; disabled?: boolean; label: string; note?: string; onChange: () => void }) {
  return <label className="ui-switch-row"><span><strong>{label}</strong>{note && <small>{note}</small>}</span><input aria-label={label} checked={checked} disabled={disabled} onChange={onChange} type="checkbox" /><i aria-hidden="true" /></label>;
}

export function RetryState({ title, description, onRetry }: { title: string; description: string; onRetry: () => void }) {
  return <Notice action={<Button onClick={onRetry}>Try again</Button>} description={description} title={title} tone="danger" />;
}

export type KeyValueItem = { label: string; value: ReactNode; detail?: ReactNode };

export function KeyValueGrid({ items, label }: { items: readonly KeyValueItem[]; label: string }) {
  return <section aria-label={label} className="ui-key-values">{items.map((item) => <article key={item.label}><span>{item.label}</span><strong>{item.value}</strong>{item.detail && <small>{item.detail}</small>}</article>)}</section>;
}
