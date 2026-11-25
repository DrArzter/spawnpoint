import type { ChangeRow, Detail, ModRow, ModsModel, ReleaseChangesModel, WorldModel } from "../../../core/models";
import type { ModSortKey } from "../../../api/contract";
import { modSourceLabel, UNKNOWN_SOURCE } from "../../../core/release-mods";
import { newestFirst } from "../../../core/release-order";
import type { StatusDescriptor } from "../../../core/status";
import { formatBytes } from "../../../lib/format";
import { action } from "../../../core/actions";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { Chip } from "../ui/Chip";
import { Copy } from "../ui/Copy";
import { DetailList } from "../ui/DetailList";
import { Empty, LoadError } from "../ui/Empty";
import { FilterBar, type FilterProperty, type FilterToken } from "../ui/FilterBar";
import { Grid } from "../ui/Grid";
import { Indicator } from "../ui/Indicator";
import { Pager } from "../ui/Pager";
import { Status } from "../ui/Status";
import { nextSort, Table, type Column } from "../ui/Table";
import { TrackList, TrackTitle } from "../ui/TrackList";
import { t } from "../../../i18n";

const pointerStates = { unconfigured: t("releases.unconfigured"), unavailable: t("common.unavailable") } as const;

/** Active, the desired release only while it differs, and the pointer's state only when it is not usable. */
function releaseFacts(model: WorldModel): Detail[] {
  const { activeRelease, desiredRelease } = model.world.release;
  const facts: Detail[] = [{ label: t("common.active"), value: activeRelease ? { type: "text", text: activeRelease, mono: true } : { type: "absent", text: "—" } }];
  if (desiredRelease && desiredRelease !== activeRelease) facts.push({ label: t("common.desired"), value: { type: "text", text: desiredRelease, mono: true } });
  if (model.releases.state !== "available") facts.push({ label: t("releases.pointer"), value: { type: "status", status: { kind: "warning", label: pointerStates[model.releases.state] } } });
  return facts;
}

/** The Release card says which release is active or desired; a download row names its release only (a state shown once). */
export function ReleasesTab({ model }: Readonly<{ model: WorldModel }>) {
  const rows = newestFirst(model.releases.rows);
  return (
    <Grid kind="stack">
      <Card body="kv" title={t("common.release")}><DetailList columns="fit" details={releaseFacts(model)} /></Card>
      {rows.some((row) => row.downloads.length > 0) && (
        <Card body="flush" title={t("releases.downloads")}>
          <TrackList
            label={t("releases.downloads")}
            rowKey={(row) => row.name}
            rows={rows}
            tracks={[
              { id: "release", header: t("common.release"), width: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle title={<span className="c-mono">{row.name}</span>} /> },
              { id: "source", header: t("common.source"), width: "120px", kind: "optional", render: (row) => row.sourceHref ? <a href={row.sourceHref} rel="noreferrer" target="_blank">{t("common.source")}</a> : <span className="c-faint">—</span> },
              { id: "download", header: t("common.download"), width: "auto", compactWidth: "auto", kind: "end", quietHeader: true, render: (row) => <>{row.downloads.map((item) => <ActionButton action={item} key={item.id} size="sm" />)}</> },
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
  removed: { kind: "warning", label: t("common.removed") },
  changed: { kind: "info", label: t("common.changed") },
  added: { kind: "ok", label: t("common.added") },
};

/** What the release changes (P3); the pair it compares is the chip, the unchanged count its tooltip. */
function Changes({ changes }: Readonly<{ changes: ReleaseChangesModel }>) {
  const state = changes.changes;
  const value = state.status === "ready" ? state.value : null;
  const head = value && <Chip icon="history" tip={t("releases.unchangedFilesUnchanged", { unchanged: value.unchanged })}>{value.from === null ? t("releases.firstReleaseRelease", { release: changes.release }) : `${value.from} → ${changes.release}`}</Chip>;
  return (
    <Card actions={head ?? undefined} body="flush" count={value?.rows.length} title={t("releases.changes")}>
      {state.status === "error"
        ? <LoadError error={state.error} kind={state.kind} retry={state.retry} size="sm" title={t("releases.changesCouldNotLoaded")} verb={t("common.readChanges")} />
        : state.status === "ready" && state.value === null
          ? <Empty icon="history" size="sm" title={t("common.releaseReleaseHasNo", { release: changes.release })} />
          : (
            <Table
              columns={[
                { id: "item", header: t("common.item"), kind: "lead", clip: true, render: (row) => <strong className="c-mono" title={row.name}>{row.name}</strong> },
                { id: "change", header: t("common.change"), render: (row) => <Status status={changeStatus[row.change]} /> },
                { id: "part", header: t("common.part"), render: (row) => row.part },
                { id: "detail", header: t("common.detail"), kind: "wide", render: (row) => row.detail ?? <span className="c-faint">—</span> },
              ]}
              empty={<Empty icon="history" size="sm" title={t("common.noChanges")} />}
              label={t("releases.changes")}
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
  return <Indicator icon={row.source === null ? "help" : sourceIcons[row.source]} label={row.source === null ? t("releases.uNKNOWNSOURCESource", { UNKNOWN_SOURCE }) : modSourceLabel(row.source)} />;
}

const SOURCE_PROPERTY = "source";

// The model keeps one search and one source; the bar shows them as tokens, and a later token of a kind replaces the earlier one.
export function tokensOf(mods: ModsModel): readonly FilterToken[] {
  const text = mods.search.trim();
  const source = mods.sources.find((entry) => entry.source === mods.source);
  return [...(text === "" ? [] : [{ property: null, value: text }]), ...(source ? [{ property: SOURCE_PROPERTY, value: source.label }] : [])];
}

export function narrow(mods: ModsModel, tokens: readonly FilterToken[]) {
  const text = tokens.filter((token) => token.property === null).at(-1);
  const source = tokens.filter((token) => token.property === SOURCE_PROPERTY).at(-1);
  mods.setSearch(text?.value ?? "");
  mods.setSource(mods.sources.find((entry) => entry.label === source?.value)?.source ?? null);
}

function Mods({ mods }: Readonly<{ mods: ModsModel }>) {
  const files = mods.files;
  const ready = files.status === "ready" ? files.value : null;
  // The source filter exists only when the release recorded sources; an old one keeps the search alone.
  const properties: readonly FilterProperty[] = mods.sources.length === 0 ? [] : [{ id: SOURCE_PROPERTY, label: t("common.source"), values: mods.sources.map(({ label, count }) => ({ value: label, count })) }];
  const sortable = (key: ModSortKey) => ({
    sort: mods.sort.key === key ? mods.sort.direction : null,
    onSort: () => mods.setSort(key, mods.sort.key === key ? nextSort(mods.sort.direction) : "ascending"),
  });
  // Whether players install their own set is a fact about the release, so it lives in the chip's tooltip.
  const head = <Chip icon="dns" tip={mods.split ? t("releases.releaseReleasePlayersInstall", { release: mods.release }) : t("common.releaseActiveRelease", { activeRelease: mods.release })}>{t("common.server")}</Chip>;
  const columns: Column<ModRow>[] = [
    { id: "mod", header: t("releases.mod"), kind: "lead", ...sortable("name"), render: (row) => <strong title={row.file}>{row.file}</strong> },
    { id: "source", header: t("common.source"), ...sortable("source"), render: (row) => <SourceMark row={row} /> },
    { id: "size", header: t("common.size"), kind: "num", ...sortable("size"), render: (row) => formatBytes(row.bytes) },
    { id: "sha", header: "SHA-256", kind: "wide", render: (row) => <span className="c-sum"><span className="c-mono" title={row.sha256}>{row.sha256.slice(0, 12)}</span><Copy value={row.sha256} what="SHA-256" /></span> },
    { id: "actions", header: t("common.actions"), kind: "act", render: (row) => <ActionButton action={row.download} size="sm" /> },
  ];
  return (
    <Card actions={head} body="flush" count={ready?.all} title={t("releases.mods")}>
      {files.status === "error"
        ? <LoadError error={files.error} kind={files.kind} retry={files.retry} size="sm" title={t("releases.modsCouldNotLoaded")} verb={t("common.readMods")} />
        : (
          <>
            <FilterBar
              disabled={files.status === "loading" && mods.sources.length === 0 && !mods.narrowed}
              end={<Pager label={t("common.modPages")} onPage={mods.setPage} page={mods.page} pages={mods.pages} />}
              label={t("common.searchMods")}
              matches={ready?.total}
              onChange={(tokens) => narrow(mods, tokens)}
              placeholder={t("common.searchByFileName")}
              properties={properties}
              tokens={tokensOf(mods)}
            />
            <Table
              columns={columns}
              empty={mods.narrowed ? <Empty action={action("mods.filter.clear", t("common.clearFilters"), mods.clear, { icon: "filter_alt_off" })} icon="filter_alt_off" size="sm" title={t("common.noMatches")} /> : <Empty icon="inventory" size="sm" title={t("releases.noMods")} />}
              label={t("releases.mods")}
              loading={files.status === "loading"}
              rowKey={(row) => row.sha256}
              rows={ready?.rows ?? []}
            />
          </>
        )}
    </Card>
  );
}
