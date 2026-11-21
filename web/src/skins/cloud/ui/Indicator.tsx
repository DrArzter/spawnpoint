import type { StatusDescriptor } from "../../../core/status";
import { cx } from "../../../lib/cx";
import { StatusIcon, statusTone } from "./Status";

/** A dense status mark: the icon alone, its word in the tooltip and the accessible name. Never a second line beside it. */
export function Indicator({ status, className }: Readonly<{ status: StatusDescriptor; className?: string }>) {
  return (
    <span aria-label={status.label} className={cx("c-indicator", `c-tone-${statusTone(status.kind)}`, className)} data-tip={status.label} role="img" tabIndex={0}>
      <StatusIcon kind={status.kind} size={17} />
    </span>
  );
}
