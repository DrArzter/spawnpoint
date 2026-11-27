import { useState, type ReactNode } from "react";

import type { PointerRow, PresetRow, ReleasesModel } from "../../core/models";
import { routeHash } from "../../routing";
import { BuildState } from "./BuildState";
import { ActionButton } from "./ui/ActionButton";
import { Card } from "./ui/Card";
import { Chip } from "./ui/Chip";
import { Empty } from "./ui/Empty";
import { applyFilter, FilterBar, type FilterProperty, type FilterToken } from "./ui/FilterBar";
import { Grid } from "./ui/Grid";
import { PageHeader } from "./ui/PageHeader";
import { SourceRef } from "./ui/SourceRef";
import { Table, type Column } from "./ui/Table";
import { t } from "../../i18n";

/**
 * Releases (spec §6.4): the game's presets with their builds, and the
 * release each world points at. Stacked at every width; the two share the
 * screen's height, each list scrolls inside its card and can be searched.
 */
export function Releases({ model }: Readonly<{ model: ReleasesModel }>) {
  const game = model.game;
  const header = <PageHeader title={t("common.releases")} trail={game ? [{ label: game.displayName, href: routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: null, worldsView: "overview" }), game: true }] : []} />;
  if (!game) {
    return (
      <div className="c-page">
        {header}
        <Card fill label={t("common.releases")}><Empty icon="public" title={t("common.noGamesYet")} /></Card>
      </div>
    );
  }
  const presets: Column<PresetRow>[] = [
    { id: "preset", header: t("common.preset"), kind: "lead", render: (row) => row.preset.displayName },
    { id: "build", header: t("common.build"), render: (row) => <BuildState row={row} /> },
    { id: "latest", header: t("common.latestRelease"), render: (row) => row.preset.latestRelease ? <span className="c-mono">{row.preset.latestRelease}</span> : <span className="c-faint">—</span> },
    { id: "releases", header: t("common.releases"), kind: "wide", className: "c-col-num", render: (row) => row.preset.releases.length },
    { id: "source", header: t("common.source"), kind: "wide", clip: true, render: (row) => <SourceRef commit={row.preset.commit} repository={row.preset.repository} /> },
    { id: "actions", header: t("common.actions"), kind: "act", render: (row) => <>{row.build && <ActionButton action={row.build} size="sm" />}{row.createWorld && <ActionButton action={row.createWorld} size="sm" />}</> },
  ];
  const pointers: Column<PointerRow>[] = [
    { id: "world", header: t("common.world"), kind: "lead", className: "c-releases-world", render: (row) => <a href={row.href} title={row.world.displayName}>{row.world.displayName}</a> },
    { id: "preset", header: t("common.preset"), clip: true, render: (row) => <span title={row.presetName}>{row.presetName}</span> },
    { id: "release", header: t("common.release"), render: (row) => <PointerRelease row={row} /> },
    { id: "wipe", header: t("common.wipe"), kind: "num", render: (row) => { const wipe = row.world.wipes.find((item) => item.state === "current"); return wipe ? `#${wipe.number}` : <span className="c-faint">—</span>; } },
  ];
  return (
    <div className="c-page">
      {header}
      <Grid fill kind="stack">
        <Searchable
          columns={presets}
          empty={<Empty icon="inventory_2" size="sm" title={t("releases.noPresets")} />}
          label={t("releases.presets")}
          loading={model.loading}
          placeholder={t("releases.searchByPreset")}
          properties={[]}
          read={() => ""}
          rowKey={(row) => row.preset.id}
          rows={model.presets}
          search={t("releases.searchPresets")}
          text={(row) => `${row.preset.displayName} ${row.preset.latestRelease ?? ""} ${row.preset.repository ?? ""}`}
        />
        <Searchable
          columns={pointers}
          empty={<Empty icon="public" size="sm" title={t("common.noWorlds")} />}
          label={t("releases.releasePointers")}
          loading={model.loading}
          placeholder={t("releases.searchByWorld")}
          properties={[presetProperty(model.pointers)]}
          read={(row) => row.presetName}
          rowKey={(row) => row.world.id}
          rows={model.pointers}
          search={t("releases.searchPointers")}
          text={(row) => `${row.world.displayName} ${row.presetName} ${row.world.release.activeRelease ?? ""} ${row.world.release.desiredRelease ?? ""}`}
        />
      </Grid>
    </div>
  );
}

/** The release a world points at; the desired one only while it differs from the active one (R3). */
function PointerRelease({ row }: Readonly<{ row: PointerRow }>) {
  const { activeRelease, desiredRelease } = row.world.release;
  return (
    <span className="c-releases-release">
      <span className="c-mono">{activeRelease ?? row.summary}</span>
      {desiredRelease !== null && desiredRelease !== activeRelease && <Chip tip={t("common.desiredDesiredRelease", { desiredRelease })}>→ {desiredRelease}</Chip>}
    </span>
  );
}

/** The preset a world points at, offered as a filter with each one's count. */
function presetProperty(rows: readonly PointerRow[]): FilterProperty {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.presetName, (counts.get(row.presetName) ?? 0) + 1);
  return { id: "preset", label: t("common.preset"), values: [...counts].map(([value, count]) => ({ value, count })) };
}

/** A list in its own card, with a search over it once it has rows. */
function Searchable<Row>({ label, search, placeholder, columns, rows, rowKey, loading, empty, properties, read, text }: Readonly<{
  label: string;
  search: string;
  placeholder: string;
  columns: Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  loading: boolean;
  empty: ReactNode;
  properties: FilterProperty[];
  read: (row: Row, property: string) => string;
  text: (row: Row) => string;
}>) {
  const [tokens, setTokens] = useState<readonly FilterToken[]>([]);
  const shown = applyFilter(rows, tokens, read, text);
  return (
    <Card body="flush" count={loading ? undefined : rows.length} fill title={label}>
      {(loading || rows.length > 0) && <FilterBar disabled={loading} label={search} matches={shown.length} onChange={setTokens} placeholder={placeholder} properties={properties} tokens={tokens} />}
      <Table columns={columns} empty={rows.length > 0 ? <Empty icon="search" size="sm" title={t("common.noMatches")} /> : empty} label={label} loading={loading} rowKey={rowKey} rows={shown} />
    </Card>
  );
}
