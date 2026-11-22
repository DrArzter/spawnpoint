import { useMemo, useState } from "react";

import type { ChangeRow, Detail, ModRow, ModsModel, ReleaseChangesModel, WorldModel } from "../../../core/models";
import { modSourceCounts, modSourceLabel, sortMods, UNKNOWN_SOURCE, type ModSortKey } from "../../../core/release-mods";
import type { StatusDescriptor } from "../../../core/status";
import { formatBytes } from "../../../lib/format";
import { action } from "../../../core/actions";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { Chip } from "../ui/Chip";
import { Copy } from "../ui/Copy";
import { DetailList } from "../ui/DetailList";
import { Empty, LoadError } from "../ui/Empty";
import { applyFilter, FilterBar, type FilterProperty, type FilterToken } from "../ui/FilterBar";
import { Grid } from "../ui/Grid";
import { Indicator } from "../ui/Indicator";
import { Status } from "../ui/Status";
import { nextSort, Table, type Column, type SortDirection } from "../ui/Table";
import { TrackList, TrackTitle } from "../ui/TrackList";

const pointerStates = { unconfigured: "Unconfigured", unavailable: "Unavailable" } as const;

/** Active, the desired release only while it differs, and the pointer's state only when it is not usable. */
function releaseFacts(model: WorldModel): Detail[] {
  const { activeRelease, desiredRelease } = model.world.release;
  const facts: Detail[] = [{ label: "Active", value: activeRelease ? { type: "text", text: activeRelease, mono: true } : { type: "absent", text: "—" } }];
  if (desiredRelease && desiredRelease !== activeRelease) facts.push({ label: "Desired", value: { type: "text", text: desiredRelease, mono: true } });
  if (model.releases.state !== "available") facts.push({ label: "Pointer", value: { type: "status", status: { kind: "warning", label: pointerStates[model.releases.state] } } });
  return facts;
}

/** The Release card says which release is active or desired; a download row names its release only (a state shown once). */
export function ReleasesTab({ model }: Readonly<{ model: WorldModel }>) {
  const rows = model.releases.rows;
  return (
    <Grid kind="stack">
      <Card body="kv" title="Release"><DetailList columns="fit" details={releaseFacts(model)} /></Card>
      {rows.some((row) => row.downloads.length > 0) && (
        <Card body="flush" title="Downloads">
          <TrackList
            label="Downloads"
            rowKey={(row) => row.name}
            rows={rows}
            tracks={[
              { id: "release", header: "Release", width: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle title={<span className="c-mono">{row.name}</span>} /> },
              { id: "source", header: "Source", width: "120px", kind: "optional", render: (row) => row.sourceHref ? <a href={row.sourceHref} rel="noreferrer" target="_blank">Source</a> : <span className="c-faint">—</span> },
              { id: "download", header: "Download", width: "auto", compactWidth: "auto", kind: "end", quietHeader: true, render: (row) => <>{row.downloads.map((item) => <ActionButton action={item} key={item.id} size="sm" />)}</> },
            ]}
          />
        </Card>
      )}
      {model.releases.changes && <Changes changes={model.releases.changes} />}
      {model.releases.mods && <Mods key={`${model.world.id}:${model.releases.mods.release}`} mods={model.releases.mods} />}
    </Grid>
  );
}

const changeStatus: Readonly<Record<ChangeRow["change"], StatusDescriptor>> = {
  removed: { kind: "warning", label: "Removed" },
  changed: { kind: "info", label: "Changed" },
  added: { kind: "ok", label: "Added" },
};

/** What the release changes (P3); the pair it compares is the chip, the unchanged count its tooltip. */
function Changes({ changes }: Readonly<{ changes: ReleaseChangesModel }>) {
  const state = changes.changes;
  const value = state.status === "ready" ? state.value : null;
  const head = value && <Chip icon="history" tip={`${value.unchanged} files unchanged`}>{value.from === null ? `First release ${changes.release}` : `${value.from} → ${changes.release}`}</Chip>;
  return (
    <Card actions={head ?? undefined} body="flush" count={value?.rows.length} title="Changes">
      {state.status === "error"
        ? <LoadError error={state.error} kind={state.kind} retry={state.retry} size="sm" title="Changes could not be loaded" verb="read changes" />
        : state.status === "ready" && state.value === null
          ? <Empty icon="history" size="sm" title={`Release ${changes.release} has no build plan`} />
          : (
            <Table
              columns={[
                { id: "item", header: "Item", kind: "lead", clip: true, render: (row) => <strong className="c-mono" title={row.name}>{row.name}</strong> },
                { id: "change", header: "Change", render: (row) => <Status status={changeStatus[row.change]} /> },
                { id: "part", header: "Part", render: (row) => row.part },
                { id: "detail", header: "Detail", kind: "wide", render: (row) => row.detail ?? <span className="c-faint">—</span> },
              ]}
              empty={<Empty icon="history" size="sm" title="No changes" />}
              label="Changes"
              loading={state.status === "loading"}
              rowKey={(row) => row.id}
              rows={value?.rows ?? []}
            />
          )}
    </Card>
  );
}

const sourceIcons = { curseforge: "deployed_code", modrinth: "layers", github: "hub" } as const;

/** One mark per source, its name in the tooltip; a release built before sources were recorded reads as unknown. */
function SourceMark({ row }: Readonly<{ row: ModRow }>) {
  return <Indicator icon={row.source === null ? "help" : sourceIcons[row.source]} label={row.source === null ? `${UNKNOWN_SOURCE} source` : modSourceLabel(row.source)} />;
}

const textOf = (row: ModRow) => row.file;
const propertyOf = (row: ModRow, property: string) => property === "source" ? modSourceLabel(row.source) : "";

function Mods({ mods }: Readonly<{ mods: ModsModel }>) {
  const files = mods.files;
  const [tokens, setTokens] = useState<readonly FilterToken[]>([]);
  const [sort, setSort] = useState<Readonly<{ key: ModSortKey; direction: SortDirection }>>({ key: "name", direction: "ascending" });
  const rows = useMemo(() => files.status === "ready" ? files.value : [], [files]);
  const shown = useMemo(() => sortMods(applyFilter(rows, tokens, propertyOf, textOf), sort.key, sort.direction), [rows, tokens, sort]);
  // The source filter exists only when the release recorded sources; an old one keeps the search alone.
  const sources = modSourceCounts(rows);
  const properties: readonly FilterProperty[] = sources.length === 0 ? [] : [{ id: "source", label: "Source", values: sources.map(({ label, count }) => ({ value: label, count })) }];
  const sortable = (key: ModSortKey) => ({
    sort: sort.key === key ? sort.direction : null,
    onSort: () => setSort({ key, direction: sort.key === key ? nextSort(sort.direction) : "ascending" }),
  });
  // Whether players install their own set is a fact about the release, so it lives in the chip's tooltip.
  const head = <Chip icon="dns" tip={mods.split ? `Release ${mods.release} · Players install their own set` : `Release ${mods.release}`}>Server</Chip>;
  const columns: Column<ModRow>[] = [
    { id: "mod", header: "Mod", kind: "lead", ...sortable("name"), render: (row) => <strong title={row.file}>{row.file}</strong> },
    { id: "source", header: "Source", ...sortable("source"), render: (row) => <SourceMark row={row} /> },
    { id: "size", header: "Size", kind: "num", ...sortable("size"), render: (row) => formatBytes(row.bytes) },
    { id: "sha", header: "SHA-256", kind: "wide", render: (row) => <span className="c-sum"><span className="c-mono" title={row.sha256}>{row.sha256.slice(0, 12)}</span><Copy value={row.sha256} what="SHA-256" /></span> },
    { id: "actions", header: "Actions", kind: "act", render: (row) => <ActionButton action={row.download} size="sm" /> },
  ];
  return (
    <Card actions={head} body="flush" count={files.status === "ready" ? files.value.length : undefined} title="Mods">
      {files.status === "error"
        ? <LoadError error={files.error} kind={files.kind} retry={files.retry} size="sm" title="Mods could not be loaded" verb="read mods" />
        : (
          <>
            <FilterBar disabled={files.status !== "ready"} label="Search mods" matches={shown.length} onChange={setTokens} placeholder="Search by file name" properties={properties} tokens={tokens} />
            <Table
              columns={columns}
              empty={tokens.length > 0 ? <Empty action={action("mods.filter.clear", "Clear filters", () => setTokens([]), { icon: "filter_alt_off" })} icon="filter_alt_off" size="sm" title="No matches" /> : <Empty icon="inventory" size="sm" title="No mods" />}
              label="Mods"
              loading={files.status === "loading"}
              rowKey={(row) => row.sha256}
              rows={shown}
            />
          </>
        )}
    </Card>
  );
}
