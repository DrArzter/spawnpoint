import type { ReactNode } from "react";

import type { StatusDescriptor } from "../../../core/status";
import { Status } from "./Status";

/** Status count tiles above a list; they scroll sideways with snap on a phone. */
export function Tiles({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return <div aria-label={label} className="c-tiles" role="group">{children}</div>;
}

/** One state and how many rows hold it; pressing it filters the list. Disabled at zero. */
export function Tile({ status, count, pressed, onPress }: Readonly<{ status: StatusDescriptor; count: number; pressed: boolean; onPress: () => void }>) {
  return (
    <button aria-pressed={pressed} className="c-tile" disabled={count === 0} onClick={onPress} type="button">
      <Status status={status} />
      <span className="c-tile-count">{count}</span>
    </button>
  );
}
