import { useLayoutEffect, useRef } from "react";

import type { HostLogRow } from "../../../core/models";
import { logTime } from "../../../core/operation-progress";

/**
 * The host's own lines of a start, newest last: mono, one wrapped entry per
 * line inside a short region that keeps the newest in view. Faults take the
 * status colours and say so in text for readers who cannot see colour.
 */
export function HostLog({ label, rows }: Readonly<{ label: string; rows: readonly HostLogRow[] }>) {
  const region = useRef<HTMLDivElement>(null);
  const newest = rows.at(-1)?.id;
  useLayoutEffect(() => {
    const element = region.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [newest]);
  return (
    <div aria-label={label} aria-live="polite" className="c-host-log" ref={region} role="log">
      {rows.map((row) => (
        <div className="c-host-line" data-tone={row.tone === "plain" ? undefined : row.tone} key={row.id}>
          <time className="c-host-time" dateTime={row.at}>{logTime(row.at)}</time>
          <span className="c-host-text">{row.tone !== "plain" && <span className="c-sr">{row.tone === "error" ? "Error: " : "Warning: "}</span>}{row.text}</span>
        </div>
      ))}
    </div>
  );
}
