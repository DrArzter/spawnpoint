import { useLayoutEffect, useRef } from "react";

import type { ConsoleLine } from "../../../core/models";
import { shortDateTime } from "./DetailList";
import { Status } from "./Status";
import { Table } from "./Table";

/**
 * A console's log as a terminal prints it: newest last, the region scrolled
 * to the newest line when one arrives (at once, no smooth scroll), and new
 * lines announced politely. Commands and output are mono, one line each,
 * with the whole text as the tooltip.
 */
export function Terminal({ label, lines }: Readonly<{ label: string; lines: readonly ConsoleLine[] }>) {
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
          { id: "who", header: "Who", kind: "wide", className: "c-term-who", render: (line) => <span title={line.who}>{line.who}</span> },
          { id: "command", header: "Command", kind: "lead", className: "c-term-command", render: (line) => <span className="c-mono" title={line.command}>{line.command}</span> },
          { id: "status", header: "Status", className: "c-term-status", render: (line) => <Status status={line.status} /> },
          { id: "output", header: "Output", className: "c-term-output", render: (line) => line.output === null ? <span className="c-faint">—</span> : <span className="c-mono" title={line.output}>{line.output}</span> },
        ]}
        label="Commands"
        rowKey={(line) => line.id}
        rows={lines}
        variant="fixed"
      />
    </div>
  );
}
