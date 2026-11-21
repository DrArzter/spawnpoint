import { useState } from "react";

import type { SiblingRow, WorldModel } from "../../../core/models";
import type { StatusKind } from "../../../core/status";
import { LinkButton } from "../ui/ActionButton";
import { Address } from "../ui/Address";
import { Chip } from "../ui/Chip";
import { Empty } from "../ui/Empty";
import { ListColumn, ListItemWorld } from "../ui/ListColumn";

type Show = "all" | "live" | "stopped" | "other";

const LIVE: readonly StatusKind[] = ["ok", "progress", "pending"];
const STOPPED: readonly StatusKind[] = ["off", "ready"];

const shows: Readonly<Record<Show, (row: SiblingRow) => boolean>> = {
  all: () => true,
  live: (row) => LIVE.includes(row.status.kind),
  stopped: (row) => STOPPED.includes(row.status.kind),
  other: (row) => !LIVE.includes(row.status.kind) && !STOPPED.includes(row.status.kind),
};

const labels: Readonly<Record<Show, string>> = { all: "All", live: "Live", stopped: "Stopped", other: "Other" };

/** The same tab of another world, so moving down the list keeps the person's place. */
function tabHref(row: SiblingRow, tab: WorldModel["tab"]): string {
  return tab === "details" ? row.href : `${row.href}/${tab}`;
}

/** The game's worlds beside the page (≥ 1024px): a filter, state chips and one row per world. */
export function Siblings({ model, rows }: Readonly<{ model: WorldModel; rows: readonly SiblingRow[] }>) {
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<Show>("all");
  const text = query.trim().toLowerCase();
  const shown = rows
    .filter((row) => shows[show](row))
    .filter((row) => text === "" || `${row.name} ${row.releaseSummary}`.toLowerCase().includes(text))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <ListColumn
      chips={(Object.keys(shows) as Show[]).map((id) => ({ id, label: labels[id], count: rows.filter(shows[id]).length, pressed: show === id, onPress: () => setShow(id) }))}
      empty={shown.length === 0 ? <Empty icon="filter_alt_off" size="sm" title="No matches" /> : undefined}
      end={<LinkButton href={model.worldsHref} icon="table_rows" iconOnly label="Table" size="sm" />}
      filter={{ value: query, set: setQuery, placeholder: "Filter worlds" }}
      groups={[{
        id: "worlds",
        items: shown.map((row) => (
          <ListItemWorld
            address={row.address ? <Address address={row.address} /> : undefined}
            current={row.id === model.world.id}
            hosting={row.placement === "fleet" ? <Chip icon="bolt">Fleet</Chip> : <Chip icon="dns">Persistent</Chip>}
            href={tabHref(row, model.tab)}
            key={row.id}
            line={row.wipe === null ? row.releaseSummary : `${row.releaseSummary} · #${row.wipe}`}
            name={row.name}
            players={row.players}
            status={row.status}
          />
        )),
      }]}
      label="Worlds"
    />
  );
}
