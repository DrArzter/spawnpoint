import { useState } from "react";

import type { WorldRow, WorldsModel } from "../../core/models";
import { StubPage } from "./Stub";
import { Address } from "./ui/Address";
import { Card } from "./ui/Card";
import { Chip } from "./ui/Chip";
import { Empty } from "./ui/Empty";
import { applyFilter, FilterBar, type FilterToken } from "./ui/FilterBar";
import { Notices } from "./ui/Notice";
import { pageOf, Pager, usePage } from "./ui/Pager";
import { TablePreferences, usePageSize } from "./ui/Preferences";
import { Status } from "./ui/Status";
import { Table } from "./ui/Table";
import { Tile, Tiles } from "./ui/Tile";

const hosting = (row: WorldRow) => row.world.placement === "fleet" ? "Fleet" : "Persistent";

// S1/S2 stand-in; S3 builds the game home and the Worlds list here.
export function Worlds({ model }: Readonly<{ model: WorldsModel }>) {
  const [tokens, setTokens] = useState<readonly FilterToken[]>([]);
  const [size, setSize] = usePageSize();
  const requests = model.requests?.status === "ready" ? model.requests.value : [];
  const more = [
    ...model.rows.flatMap((row) => row.sessionAction ? [row.sessionAction()] : []),
    ...requests.flatMap((request) => {
      const verbs = model.requestActions?.(request.id);
      return verbs ? [verbs.approve, verbs.dismiss] : [];
    }),
  ];
  const read = (row: WorldRow, property: string) => property === "status" ? row.status.label : hosting(row);
  const shown = applyFilter(model.rows, tokens, read, (row) => `${row.world.displayName} ${row.presetName} ${row.releaseSummary}`);
  const [page, setPage] = usePage(shown.length);
  const paged = pageOf(shown, page, size);
  const states = [...new Map(model.rows.map((row) => [row.status.label, row.status])).values()];
  const values = (pick: (row: WorldRow) => string) => [...new Set(model.rows.map(pick))].map((value) => ({ value, count: model.rows.filter((row) => pick(row) === value).length }));
  const statusToken = tokens.find((token) => token.property === "status");
  return (
    <StubPage model={model} more={more} title={model.view === "overview" ? model.game?.displayName ?? "Home" : "Worlds"}>
      <Notices notices={model.notices} />
      <Tiles label="Worlds by state">
        {states.map((status) => (
          <Tile count={model.rows.filter((row) => row.status.label === status.label).length} key={status.label} onPress={() => setTokens(statusToken?.value === status.label ? tokens.filter((token) => token !== statusToken) : [...tokens.filter((token) => token !== statusToken), { property: "status", value: status.label }])} pressed={statusToken?.value === status.label} status={status} />
        ))}
      </Tiles>
      <Card body="flush" count={model.rows.length} title="Worlds">
        <FilterBar
          end={<TablePreferences pageSize={{ value: size, set: setSize }} />}
          label="Filter worlds"
          matches={shown.length}
          onChange={setTokens}
          properties={[{ id: "status", label: "Status", values: values((row) => row.status.label) }, { id: "hosting", label: "Hosting", values: values(hosting) }]}
          tokens={tokens}
        />
        <Table
          columns={[
            { id: "name", header: "Name", kind: "lead", render: (row) => <a href={row.href}>{row.world.displayName}</a> },
            { id: "status", header: "Status", render: (row) => <Status status={row.status} /> },
            { id: "hosting", header: "Hosting", kind: "wide", render: (row) => <Chip>{hosting(row)}</Chip> },
            { id: "release", header: "Preset · release", render: (row) => `${row.presetName} · ${row.releaseSummary}` },
            { id: "players", header: "Players", kind: "num", render: (row) => row.players ?? "—" },
            { id: "address", header: "Address", kind: "optional", render: (row) => row.address ? <Address address={row.address} copy /> : <span className="c-faint">{row.addressAbsent}</span> },
          ]}
          empty={<Empty icon="public" size="sm" title="No worlds match" />}
          label="Worlds"
          loading={model.status === "loading"}
          rowKey={(row) => row.world.id}
          rows={paged.rows}
        />
        <Pager onPage={setPage} page={paged.page} pages={paged.pages} />
      </Card>
    </StubPage>
  );
}
