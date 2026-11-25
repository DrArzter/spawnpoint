import { useLayoutEffect, useRef } from "react";

import type { ConsoleLine } from "../../../core/models";
import { shortDateTime } from "./DetailList";
import { Status } from "./Status";
import { Table } from "./Table";
import { t } from "../../../i18n";

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
          { id: "time", header: t("common.time"), className: "c-term-time", render: (line) => shortDateTime(line.at) ?? line.at },
          { id: "who", header: t("rcon.who"), className: "c-term-who", render: (line) => <span title={line.who}>{line.who}</span> },
          { id: "command", header: t("rcon.command"), kind: "lead", className: "c-term-command", render: (line) => <span className="c-mono" title={line.command}>{line.command}</span> },
          { id: "status", header: t("common.status"), className: "c-term-status", render: (line) => <span title={line.status.label}><Status status={line.status} /></span> },
          { id: "output", header: t("rcon.output"), className: "c-term-output", render: (line) => line.output === null ? <span className="c-faint">—</span> : <span className="c-mono" title={line.output}>{line.output}</span> },
        ]}
        arrivals
        label={t("rcon.commands")}
        loading={loading}
        rowKey={(line) => line.id}
        rows={lines}
        variant="fixed"
      />
    </div>
  );
}
