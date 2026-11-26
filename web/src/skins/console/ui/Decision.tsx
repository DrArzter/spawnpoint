import type { Action } from "../../../core/actions";
import { ActionButton } from "./ActionButton";

/**
 * A request's decision in a row: Approve and Dismiss as two small named icon
 * buttons of one style (owner rule 4), compact enough for a narrow card; the
 * word is their accessible name and tooltip. Every list of requests draws its
 * decision with this; a page header keeps its worded buttons.
 */
export function Decision({ approve, dismiss }: Readonly<{ approve: Action; dismiss: Action }>) {
  return (
    <span className="c-decide">
      <ActionButton action={approve} iconOnly size="sm" />
      <ActionButton action={dismiss} iconOnly size="sm" />
    </span>
  );
}
