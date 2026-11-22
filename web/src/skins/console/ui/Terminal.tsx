import { useLayoutEffect, useRef } from "react";

import type { ConsoleLine } from "../../../core/models";
import { shortDateTime } from "./DetailList";
import { Status } from "./Status";
import { Table } from "./Table";

/**
 * A console's log as a terminal prints it: newest last, the region scrolled
 * to the newest line when one arrives (at once, no smooth scroll), new lines
 * announced politely and highlighted as they arrive (A9). Commands and output
 * are mono, one line each, with the whole text as the tooltip.
 */
export function Terminal({ label, lines, loading = false }: Readonly<{ label: string; lines: readonly ConsoleLine[]; /** The log is on its way: placeholder rows on the same columns. */ loading?: boolean }>) {
  const region = useRef<HTMLDivElement>(null);
  const newest = lines.at(-1)?.id;
  useLayoutEffect(() => {
    const element = region.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [newest]);
  return (
    <div aria-label={label} aria-live="polite" className="c-terminal" ref={region} role="log">
      <Table
        columns={[
          { id: "time", header: "Time", className: "c-term-time", render: (line) => shortDateTime(line.at) ?? line.at },
          { id: "who", header: "Who", className: "c-term-who", render: (line) => <span title={line.who}>{line.who}</span> },
          { id: "command", header: "Command", kind: "lead", className: "c-term-command", render: (line) => <span className="c-mono" title={line.command}>{line.command}</span> },
          { id: "status", header: "Status", className: "c-term-status", render: (line) => <span title={line.status.label}><Status status={line.status} /></span> },
          { id: "output", header: "Output", className: "c-term-output", render: (line) => line.output === null ? <span className="c-faint">—</span> : <span className="c-mono" title={line.output}>{line.output}</span> },
        ]}
        arrivals
        label="Commands"
        loading={loading}
        rowKey={(line) => line.id}
        rows={lines}
        variant="fixed"
      />
    </div>
  );
}
