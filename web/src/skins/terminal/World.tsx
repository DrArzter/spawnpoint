import { useRef, type ReactNode } from "react";

import type { BackupEntry } from "../../api/contract";
import { Timestamp } from "../../components/ui/Timestamp";
import { action } from "../../core/actions";
import type { Filter } from "../../components/ui/Filter";
import type { BackupsModel, ChangeRow, Detail, DetailValue, ModRow, ModsModel, OperationProgressModel, ReleaseChangesModel, ReleaseRow, WorldModel } from "../../core/models";
import { progressDetails, useSecondClock } from "../../core/operation-progress";
import { modSourceLabel } from "../../core/release-mods";
import { newestFirst } from "../../core/release-order";
import type { StatusKind } from "../../core/status";
import { wipeStatus } from "../../core/worlds";
import { Icon } from "../../icons";
import { formatBytes, formatTime, shortDigest } from "../../lib/format";
import { useMediaQuery } from "../../shell/hooks";
import { Address, Choice, Choices, Col, DetailRow, DetailsGroup, Empty, Field, FilterRow, Ghost, Indicator, LoadError, Log, NoMatches, Notice, Overflow, Page, Pager, Panel, SelectInput, Skeleton, State, Table, Tabs, Verb, Verbs } from "./ui";
import { MetricsPanel } from "./Metrics";
import { ConsolePanel } from "./Rcon";
import { ConfigPanel } from "./Config";
import { LogPanel } from "./Log";
import { WhitelistPanel } from "./Whitelist";
import { Notices } from "./Worlds";
import { t } from "../../i18n";

// One world: its name and state on the first line, its verbs on the second
// with the one that matters first, the notices, then the sections behind tabs.
export function World({ model }: Readonly<{ model: WorldModel }>) {
  const { world, game } = model;
  const compact = useMediaQuery("(max-width: 839px)");
  const compactActions = [model.refresh, ...(model.invite ? [model.invite] : [])];

  return (
    <Page>
      <header className="t-page-head" data-tip-side="bottom">
        <div className="t-page-title">
          <a className="t-crumb" href={model.worldsHref}><span aria-hidden="true">&lt;</span> {t("common.worlds")}</a>
          <h1>{world.displayName}</h1>
          <Indicator kind={model.sessionStatus.kind} label={model.sessionStatus.label} />
        </div>
        <Verbs className="t-page-verbs">
          <Verb action={model.session} tone="primary" tooltipWhenDisabled />
          {!compact && <Verb action={model.refresh} />}
          {!compact && model.invite && <Verb action={model.invite} />}
          {(compact || model.more.length > 0) && <Overflow groups={compact ? [compactActions, model.more] : [model.more]} label={t("world.moreActionsWorldDisplayName", { worldDisplayName: world.displayName })} />}
        </Verbs>
      </header>
      <Notices notices={model.notices} />

      <Tabs label={t("world.worldSections")} onChange={model.setTab} options={model.tabs} value={model.tab} />
      {model.tab === "details" && <>
        <Panel>
          <div className="t-details-columns">
            {model.progress ? <ProgressGroup model={model.progress} /> : <DetailsGroup items={model.sessionDetails.map(detailRow)} level={2} title={t("world.session")} />}
            <DetailsGroup items={model.worldDetails.map(detailRow)} level={2} title={t("common.world")} />
          </div>
        </Panel>
        <Panel flush name={t("common.operations")}>
          <Table columns={operationColumns} empty={<Empty title={t("world.noOperationProgress")} />} label={t("world.runningOperations")} rowKey={(row) => `${row.operation.type}-${row.operation.id}`} rows={model.operations} />
        </Panel>
      </>}
      {model.tab === "wipes" && <WipesTab rows={model.wipes} worldName={world.displayName} />}
      {model.tab === "backups" && <BackupsTab model={model.backups} worldName={world.displayName} />}
      {model.tab === "releases" && <ReleasesTab releases={model.releases} worldName={world.displayName} />}
      {model.tab === "whitelist" && model.whitelist && <WhitelistPanel model={model.whitelist} />}
      {model.tab === "config" && model.config && <ConfigPanel model={model.config} />}
      {model.tab === "console" && model.console && <ConsolePanel model={model.console} />}
      {model.tab === "log" && model.log && <LogPanel model={model.log} />}
      {model.tab === "metrics" && model.metrics && <MetricsPanel model={model.metrics} />}
      <span className="visually-hidden">{game.displayName}</span>
    </Page>
  );
}

// The running operation, or the one that just failed, in the session's place: its step and times, then the cause.
function ProgressGroup({ model }: Readonly<{ model: OperationProgressModel }>) {
  const now = useSecondClock(model.running);
  return (
    <DetailsGroup items={progressDetails(model, now).map(detailRow)} label={`${model.title}: ${model.status.label}`} level={2} state={<State kind={model.status.kind} label={model.status.label} />} title={model.title}>
      {(model.log.length > 0 || (model.running && model.logged)) && <Log label={t("common.titleHostLog", { title: model.title })} live={model.running} rows={model.log} />}
    </DetailsGroup>
  );
}

function detailValue(value: DetailValue): ReactNode {
  switch (value.type) {
    case "text": return value.mono ? <code>{value.text}</code> : <span>{value.text}</span>;
    case "absent": return <Ghost>{value.text}</Ghost>;
    case "loading": return <span><Skeleton width="medium" /><span className="visually-hidden">{t("common.loading")}</span></span>;
    case "status": return <State kind={value.status.kind} label={value.status.label} />;
    case "time": return <Timestamp value={value.at} />;
    case "number": return <strong>{value.value}</strong>;
    case "release": {
      const aligned = value.active !== null && value.active === value.desired;
      const label = aligned ? t("world.activeDesired") : t("world.activeDesiredReleases", { active: value.active ?? t("world.releaseNone"), desired: value.desired ?? t("world.releaseNone") });
      return <span className="t-inline"><code>{value.desired ?? value.active ?? t("world.releaseNone")}</code><Indicator kind={aligned ? "ok" : "pending"} label={label} /></span>;
    }
    case "preset": return <span className="t-inline">
      <span>{value.name}</span>
      {value.source && <a className="t-source" href={value.source.href} rel="noreferrer" target="_blank" title={value.source.commit}><code>{value.source.short}</code><Icon name="open_in_new" size={14} /></a>}
    </span>;
    default: return <Address connectivity={value.address.connectivity} network={value.address.network} value={value.address.value} />;
  }
}

function detailHint(detail: Detail): ReactNode {
  if (detail.hintTime !== undefined) return <>{detail.hint} <Timestamp value={detail.hintTime} /></>;
  if (!detail.hint) return undefined;
  return <span className={detail.hintAttention ? "t-attention" : undefined}>{detail.hint}</span>;
}

function detailRow(detail: Detail): DetailRow {
  return { label: detail.label, value: detailValue(detail.value), hint: detailHint(detail), explain: detail.explain, copy: detail.copy };
}

function partialInventoryDescription(unverified: number, truncated: boolean): string {
  const parts: string[] = [];
  if (unverified > 0) parts.push(t("world.unverifiedNotShown", { count: unverified }));
  if (truncated) parts.push(t("world.olderBackupsExistBeyond"));
  return parts.join(" ");
}

const operationColumns: readonly Col<WorldModel["operations"][number]>[] = [
  { id: "operation", label: t("common.operation"), render: (row) => <strong>{row.label}</strong> },
  { id: "execution", label: t("world.execution"), truncate: true, render: (row) => <code className="t-clip">{row.operation.id}</code> },
  { id: "started", label: t("world.started"), width: "140px", render: (row) => <span>{formatTime(row.operation.startedAt)}</span> },
  { id: "status", label: t("common.status"), width: "80px", render: () => <Indicator kind="progress" label={t("common.running")} /> },
];

function WipesTab({ rows, worldName }: Readonly<{ rows: WorldModel["wipes"]; worldName: string }>) {
  const columns: readonly Col<WorldModel["wipes"][number]>[] = [
    { id: "wipe", label: t("common.wipe"), width: "100px", render: (row) => <strong>#{row.wipe.number}</strong> },
    { id: "status", label: t("common.status"), width: "80px", render: (row) => <Indicator kind={row.wipe.state === "current" ? "ok" : "archived"} label={wipeStatus(row.wipe).label} /> },
    { id: "release", label: t("world.startedRelease"), width: "160px", render: (row) => <code>{row.wipe.originRelease}</code> },
    { id: "opened", label: t("world.opened"), render: (row) => <Timestamp value={row.wipe.createdAt} /> },
    { id: "closed", label: t("world.closed"), render: (row) => (row.wipe.closedAt ? <Timestamp value={row.wipe.closedAt} /> : <Ghost>{t("world.open")}</Ghost>) },
    { id: "verbs", label: t("common.actions"), verbs: true, corner: true, render: (row) => <Overflow groups={[[row.showBackups]]} label={t("world.actionsWipeNumber", { number: row.wipe.number })} size="small" /> },
  ];
  return (
    <Panel flush name={t("world.wipes")}>
      <Table columns={columns} empty={<Empty title={t("world.noWipesYet")} />} label={t("world.wipesWorldName", { worldName })} rowKey={(row) => row.wipe.id} rows={rows} />
    </Panel>
  );
}

function BackupsTab({ model, worldName }: Readonly<{ model: BackupsModel; worldName: string }>) {
  const columns: readonly Col<BackupEntry>[] = [
    { id: "archive", label: t("world.archive"), truncate: true, render: (entry) => <code className="t-clip" title={entry.archiveName}>{entry.archiveName}</code> },
    { id: "wipe", label: t("common.wipe"), width: "90px", render: (entry) => { const number = model.wipeNumber(entry.generationId); return number !== undefined ? <span>#{number}</span> : <Ghost>{t("world.legacy")}</Ghost>; } },
    { id: "stored", label: t("world.stored"), width: "170px", render: (entry) => <Timestamp value={entry.storedAt} /> },
    { id: "size", label: t("common.size"), width: "130px", align: "end", render: (entry) => formatBytes(entry.sizeBytes) },
    { id: "checksum", label: "SHA-256", secondary: true, optional: true, width: "180px", render: (entry) => <Digest value={entry.checksum} /> },
    { id: "verbs", label: t("common.actions"), verbs: true, corner: true, render: (entry) => <Overflow groups={[
      [copyValueAction(`backup.copy-archive.${entry.key}`, t("world.copyArchiveName"), entry.archiveName), copyValueAction(`backup.copy-checksum.${entry.key}`, t("world.copySHA256"), entry.checksum)],
      ...(model.download ? [[model.download(entry)]] : []),
      [model.restore(entry)],
    ]} label={t("common.actionsMemberName", { memberName: entry.archiveName })} size="small" /> },
  ];

  if (!model.canRead) {
    return <Panel flush name={t("common.backups")}><Empty description={t("world.askOwnerBackupRead")} title={t("common.roleCannotReadBackups")} /></Panel>;
  }
  const inventory = model.inventory;
  return (
    <Panel flush name={t("common.backups")}>
      {model.wipes.length > 0 && (
        <div className="t-filter-row">
          <Choices label={t("world.filterBackupsByWipe")}>
            <Choice onClick={() => model.setFilter(null)} pressed={model.filter === null}>{t("world.allWipes")}</Choice>
            {[...model.wipes].reverse().map((wipe) => <Choice key={wipe.id} onClick={() => model.setFilter(wipe.id)} pressed={model.filter === wipe.id}>{t("backups.wipeNumber", { number: wipe.number })}</Choice>)}
          </Choices>
        </div>
      )}
      {inventory.status === "error" && <div className="t-inset"><LoadError state={inventory} title={t("world.inventoryCouldNotLoaded")} verb={t("common.readBackups")} /></div>}
      {inventory.status !== "error" && <Table
        columns={columns}
        empty={<Empty title={t("world.noVerifiedBackups")} />}
        label={t("world.verifiedBackupsWorldName", { worldName })}
        loading={inventory.status === "loading"}
        rowKey={(entry) => entry.key}
        rows={inventory.status === "ready" ? inventory.value.entries : []}
      />}
      {inventory.status === "ready" && (inventory.value.unverified > 0 || inventory.value.truncated) && (
        <div className="t-inset"><Notice description={partialInventoryDescription(inventory.value.unverified, inventory.value.truncated)} title={t("world.inventoryPartial")} tone="warning" /></div>
      )}
    </Panel>
  );
}

// A SHA-256: its start in a narrow column, all of it where there is room.
function Digest({ value }: Readonly<{ value: string }>) {
  return <code className="t-checksum" title={value}><span className="t-checksum-short">{shortDigest(value)}</span><span className="t-checksum-full">{value}</span></code>;
}

function ReleasesTab({ releases, worldName }: Readonly<{ releases: WorldModel["releases"]; worldName: string }>) {
  const columns: readonly Col<ReleaseRow>[] = [
    { id: "release", label: t("common.release"), render: (row) => <span className="t-release-line">
      {row.sourceRepository ? <a className="t-source" href={row.sourceRepository} rel="noreferrer" target="_blank" title={t("world.openPresetRepository")}><code>{row.name}</code><Icon name="open_in_new" size={14} /></a> : <code>{row.name}</code>}
      <Indicator kind={row.downloadable ? "ok" : "pending"} label={row.downloadable ? row.status : t("world.desiredNotYetActive")} />
      {row.downloads.length > 0 && <Verbs align="end">{row.downloads.map((pack) => <Verb action={pack} key={pack.id} size="small" />)}</Verbs>}
    </span> },
  ];
  return <>
    <Panel flush>
      <Table columns={columns} empty={<Empty title={t("world.noRelease")} />} label={t("world.releasePointerWorldName", { worldName })} rowKey={(row) => row.name} rows={newestFirst(releases.rows)} />
    </Panel>
    {releases.changes && <ChangesPanel changes={releases.changes} worldName={worldName} />}
    {releases.mods && <ModsPanel key={`${worldName}:${releases.mods.release}`} mods={releases.mods} worldName={worldName} />}
  </>;
}

const changeStates: Readonly<Record<ChangeRow["change"], Readonly<{ kind: StatusKind; label: string }>>> = {
  removed: { kind: "warning", label: t("common.removed") },
  changed: { kind: "info", label: t("common.changed") },
  added: { kind: "ok", label: t("common.added") },
};

// What the release changes (P3): losses first, then changes, then additions.
function ChangesPanel({ changes, worldName }: Readonly<{ changes: ReleaseChangesModel; worldName: string }>) {
  const columns: readonly Col<ChangeRow>[] = [
    { id: "change", label: t("common.change"), width: "130px", render: (row) => <State kind={changeStates[row.change].kind} label={changeStates[row.change].label} /> },
    { id: "item", label: t("common.item"), truncate: true, render: (row) => <code className="t-clip" title={row.name}>{row.name}</code> },
    { id: "part", label: t("common.part"), width: "130px", render: (row) => row.part },
    { id: "detail", label: t("common.detail"), secondary: true, optional: true, render: (row) => row.detail ?? "—" },
  ];
  const state = changes.changes;
  const value = state.status === "ready" ? state.value : null;
  const name = value === null ? t("world.changesReleaseRelease", { release: changes.release })
    : t("world.changesValueRelease", { value: value.from ?? t("world.firstRelease"), release: changes.release });
  return (
    <Panel flush name={name}>
      {state.status === "error"
        ? <div className="t-inset"><LoadError state={state} title={t("world.changesCouldNotLoaded")} verb={t("common.readChanges")} /></div>
        : state.status === "ready" && state.value === null
          ? <Empty title={t("common.releaseReleaseHasNo", { release: changes.release })} />
          : <Table
            columns={columns}
            empty={<Empty title={t("common.noChanges")} />}
            label={t("world.changesWorldNameReleaseRelease", { worldName, release: changes.release })}
            loading={state.status === "loading"}
            rowKey={(row) => row.id}
            rows={value?.rows ?? []}
          />}
    </Panel>
  );
}

const sourceGlyphs = { curseforge: "C", modrinth: "M", github: "G" } as const;

// A release built before sources were recorded reads as unknown.
function SourceMark({ source }: Readonly<{ source: ModRow["source"] }>) {
  return source === null ? <Indicator kind="unknown" label={t("world.unknownSource")} /> : <Indicator glyph={sourceGlyphs[source]} label={modSourceLabel(source)} />;
}

const modSorts = (["name", "source", "size"] as const).flatMap((key) => (["ascending", "descending"] as const).map((direction) => ({ key, direction, value: `${key}:${direction}`, label: `${key.charAt(0).toUpperCase()}${key.slice(1)}, ${direction}` })));

// Every mod of the release the world starts with, of both sides (ADR-0065,
// ADR-0069), one page at a time; the packs that sort them are on the release row.
function ModsPanel({ mods, worldName }: Readonly<{ mods: ModsModel; worldName: string }>) {
  const columns: readonly Col<ModRow>[] = [
    { id: "file", label: t("common.file"), truncate: true, render: (row) => <code className="t-clip" title={row.file}>{row.file}</code> },
    { id: "source", label: t("common.source"), width: "90px", render: (row) => <SourceMark source={row.source} /> },
    { id: "size", label: t("common.size"), width: "110px", align: "end", render: (row) => formatBytes(row.bytes) },
    { id: "checksum", label: "SHA-256", secondary: true, width: "180px", render: (row) => <Digest value={row.sha256} /> },
    { id: "verbs", label: t("common.actions"), verbs: true, corner: true, render: (row) => <Overflow groups={[[row.download]]} label={t("common.actionsMemberName", { memberName: row.file })} size="small" /> },
  ];
  const files = mods.files;
  const ready = files.status === "ready" ? files.value : null;
  const field = useRef<HTMLInputElement | null>(null);
  const filter: Filter<ModRow> = {
    query: mods.search,
    setQuery: mods.setSearch,
    clear: () => { mods.clear(); field.current?.focus(); },
    active: ready !== null && mods.search.trim() !== "",
    rows: [],
    total: ready?.all ?? 0,
    field,
  };
  return (
    <Panel flush name={t("world.modsReleaseRelease", { release: mods.release })}>
      {files.status === "error"
        ? <div className="t-inset"><LoadError state={files} title={t("world.modsCouldNotLoaded")} verb={t("common.readMods")} /></div>
        : <>
          <FilterRow disabled={files.status === "loading" && mods.sources.length === 0 && !mods.narrowed} filter={filter} label={t("common.searchMods")} matches={ready?.total} placeholder={t("common.searchByFileName")}>
            <Field hideLabel label={t("world.sortMods")}>
              <SelectInput onChange={(event) => { const next = modSorts.find((item) => item.value === event.target.value); if (next) mods.setSort(next.key, next.direction); }} value={`${mods.sort.key}:${mods.sort.direction}`}>
                {modSorts.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </SelectInput>
            </Field>
            {mods.sources.length > 0 && (
              <Choices label={t("world.filterModsBySource")}>
                <Choice onClick={() => mods.setSource(null)} pressed={mods.source === null}>{t("common.all")}</Choice>
                {mods.sources.map((item) => <Choice key={item.source} onClick={() => mods.setSource(item.source)} pressed={mods.source === item.source}>{item.label}</Choice>)}
              </Choices>
            )}
          </FilterRow>
          <Table
            columns={columns}
            empty={mods.narrowed ? <NoMatches clearLabel={t("common.clearFilters")} filter={{ query: mods.search.trim(), clear: mods.clear }} noun="mods" /> : <Empty title={t("world.releaseHasNoMods")} />}
            label={t("world.modsWorldNameReleaseRelease", { worldName, release: mods.release })}
            loading={files.status === "loading"}
            rowKey={(row) => row.sha256}
            rows={ready?.rows ?? []}
          />
          <Pager label={t("common.modPages")} onPage={mods.setPage} page={mods.page} pages={mods.pages} />
        </>}
    </Panel>
  );
}

function copyValueAction(id: string, label: string, value: string) {
  return action(id, label, () => { void navigator.clipboard?.writeText(value); }, { icon: "content_copy" });
}
