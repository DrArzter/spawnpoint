import { cx } from "../../../lib/cx";

/** Work with no known progress (A11): a bar that travels, never a percentage. */
export function ProgressBar({ label, className }: Readonly<{ label: string; className?: string }>) {
  return (
    <span aria-label={label} className={cx("c-progress", className)} role="progressbar">
      <span className="c-progress-run" />
    </span>
  );
}
