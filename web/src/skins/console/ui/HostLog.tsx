import { useLayoutEffect, useRef } from "react";

import type { HostLogRow } from "../../../core/models";
import { logTime } from "../../../core/operation-progress";
import { Skeleton } from "./Skeleton";

// Placeholder lines while a live log has none yet, as wide as typical lines.
const WAITING = ["14em", "22em", "18em"] as const;

/**
 * The host's own lines of a start, newest last: mono, one wrapped entry per
 * line inside a short region that keeps the newest in view. Faults take the
 * status colours and say so in text for readers who cannot see colour.
 * A `live` log keeps one height while lines arrive, with placeholders until
 * the first one.
 */
export function HostLog({ label, rows, live = false, tall = false }: Readonly<{ label: string; rows: readonly HostLogRow[]; live?: boolean; /** A game's whole recent log: a taller region. */ tall?: boolean }>) {
  const region = useRef<HTMLDivElement>(null);
  const newest = rows.at(-1)?.id;
  useLayoutEffect(() => {
    const element = region.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [newest]);
  return (
    <div aria-busy={live && rows.length === 0 ? true : undefined} aria-label={label} aria-live="polite" className="c-host-log" data-live={live ? "" : undefined} data-size={tall ? "tall" : undefined} ref={region} role="log">
      {live && rows.length === 0 && WAITING.map((width) => <div className="c-host-line" key={width}><Skeleton text width={width} /></div>)}
      {rows.map((row) => (
        <div className="c-host-line" data-tone={row.tone === "plain" ? undefined : row.tone} key={row.id}>
          {row.at !== null && <time className="c-host-time" dateTime={row.at}>{logTime(row.at)}</time>}
          <span className="c-host-text">{row.tone !== "plain" && <span className="c-sr">{row.tone === "error" ? "Error: " : "Warning: "}</span>}{row.text}</span>
        </div>
      ))}
    </div>
  );
}
