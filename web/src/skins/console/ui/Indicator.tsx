import type { StatusDescriptor } from "../../../core/status";
import { Icon, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";
import { StatusIcon, statusTone } from "./Status";

/**
 * A dense mark: the icon alone, its word in the tooltip and the accessible
 * name. Never a second line beside it. A status draws in its tone; a plain
 * fact (hosting, a granted permission) names its own icon and stays quiet.
 */
export function Indicator(props: Readonly<({ status: StatusDescriptor } | { icon: IconName; label: string }) & { className?: string }>) {
  const label = "status" in props ? props.status.label : props.label;
  const tone = "status" in props ? `c-tone-${statusTone(props.status.kind)}` : "c-indicator-quiet";
  return (
    <span aria-label={label} className={cx("c-indicator", tone, props.className)} data-status={"status" in props ? props.status.kind : undefined} data-tip={label} role="img" tabIndex={0 /* NOSONAR focusable tooltip trigger */}>
      {"status" in props ? <StatusIcon kind={props.status.kind} size={17} /> : <Icon name={props.icon} size={17} />}
    </span>
  );
}
