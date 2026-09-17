import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes } from "react";

import { Icon } from "../../icons";
import { cx } from "../../lib/cx";

export function TextField({ label, hint, className, mono = false, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; mono?: boolean }) {
  return (
    <label className={cx("field", className)}>
      <span>{label}</span>
      <input className={cx(mono && "mono")} {...props} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function SelectField({ label, hint, className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: ReactNode }) {
  return (
    <label className={cx("field", className)}>
      <span>{label}</span>
      <select {...props}>{children}</select>
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function InlineSelect({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx("inline-select", className)} {...props}>{children}</select>;
}

export function SearchField({ label, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; ref?: Ref<HTMLInputElement> }) {
  return (
    <div className={cx("search", className)}>
      <Icon name="search" size={20} />
      <input aria-label={label} type="search" {...props} />
    </div>
  );
}

// `labelHidden` is for a cell whose column header already names the setting:
// the label still reaches a screen reader, it just stops taking the width.
export function Switch({ checked, disabled = false, label, note, onChange, labelHidden = false }: { checked: boolean; disabled?: boolean; label: string; note?: string; onChange: () => void; labelHidden?: boolean }) {
  if (labelHidden) {
    return (
      <label className="switch">
        <input aria-label={label} checked={checked} disabled={disabled} onChange={onChange} type="checkbox" />
        <span aria-hidden="true" className="switch-track" />
      </label>
    );
  }
  return (
    <div className="switch-row">
      <span>
        <strong>{label}</strong>
        {note && <small>{note}</small>}
      </span>
      <label className="switch">
        <input aria-label={label} checked={checked} disabled={disabled} onChange={onChange} type="checkbox" />
        <span aria-hidden="true" className="switch-track" />
      </label>
    </div>
  );
}
