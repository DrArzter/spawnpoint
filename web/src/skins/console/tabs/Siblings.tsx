import { useState } from "react";

import type { SiblingRow, WorldModel } from "../../../core/models";
import type { StatusKind } from "../../../core/status";
import { LinkButton } from "../ui/ActionButton";
import { Address } from "../ui/Address";
import { Chip } from "../ui/Chip";
import { Empty } from "../ui/Empty";
import { ListColumn, ListItemWorld } from "../ui/ListColumn";
import { t } from "../../../i18n";

type Show = "all" | "live" | "stopped" | "other";

const LIVE: ReadonlySet<StatusKind> = new Set(["ok", "progress", "pending"]);
const STOPPED: ReadonlySet<StatusKind> = new Set(["off", "ready"]);

const shows: Readonly<Record<Show, (row: SiblingRow) => boolean>> = {
  all: () => true,
  live: (row) => LIVE.has(row.status.kind),
  stopped: (row) => STOPPED.has(row.status.kind),
  other: (row) => !LIVE.has(row.status.kind) && !STOPPED.has(row.status.kind),
};

const labels: Readonly<Record<Show, string>> = { all: t("common.all"), live: t("world.filterLive"), stopped: t("world.filterStopped"), other: t("common.other") };

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
      empty={shown.length === 0 ? <Empty icon="filter_alt_off" size="sm" title={t("common.noMatches")} /> : undefined}
      end={<LinkButton href={model.worldsHref} icon="table_rows" iconOnly label={t("world.table")} size="sm" />}
      filter={{ value: query, set: setQuery, placeholder: t("world.filterWorlds") }}
      groups={[{
        id: "worlds",
        items: shown.map((row) => (
          <ListItemWorld
            address={row.address ? <Address address={row.address} /> : undefined}
            current={row.id === model.world.id}
            hosting={row.placement === "fleet" ? <Chip icon="bolt">{t("world.fleet")}</Chip> : <Chip icon="dns">{t("world.persistent")}</Chip>}
            href={tabHref(row, model.tab)}
            key={row.id}
            line={row.wipe === null ? row.releaseSummary : `${row.releaseSummary} · #${row.wipe}`}
            name={row.name}
            players={row.players}
            status={row.status}
          />
        )),
      }]}
      label={t("common.worlds")}
    />
  );
}
