import { useId, type InputHTMLAttributes, type ReactNode } from "react";

import { cx } from "../../lib/cx";

// An error is why the value cannot be saved; it stays under the hint, which
// often names what the value may hold.
export function TextField({ label, hideLabel = false, hint, error = null, className, mono = false, ...props }: Readonly<InputHTMLAttributes<HTMLInputElement> & { label: string; hideLabel?: boolean; hint?: ReactNode; error?: string | null; mono?: boolean }>) {
  const errorId = useId();
  return (
    <label className={cx("field", className)}>
      <span className={hideLabel ? "visually-hidden" : undefined}>{label}</span>
      <input aria-describedby={error ? errorId : undefined} aria-invalid={error ? true : undefined} className={cx(mono && "mono")} {...props} />
      {hint && <small>{hint}</small>}
      {error && <small className="field-error" id={errorId}>{error}</small>}
    </label>
  );
}
