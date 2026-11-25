import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { action, type Action } from "../../core/actions";
import type { Detail, WorldRow, WorldsModel } from "../../core/models";
import { cx } from "../../lib/cx";
import { eta } from "../../lib/operation-time";
import { Home, withIcon } from "./Home";
import { HostingChip, HostingMark, Players, hostingLabel, releaseLine, statesOf, statusRank } from "./WorldFacts";
import { formatUptime } from "../../lib/format";
import { connectionLabel } from "../../core/worlds";
import { ActionButton, LinkButton } from "./ui/ActionButton";
import { Address } from "./ui/Address";
import { Card } from "./ui/Card";
import { Chip } from "./ui/Chip";
import { DetailList } from "./ui/DetailList";
import { Empty, GamesEmpty, LoadError } from "./ui/Empty";
import { Checkbox } from "./ui/Fields";
import { applyFilter, FilterBar, type FilterProperty, type FilterToken } from "./ui/FilterBar";
import { elapsed, useNow } from "./ui/Flashbar";
import { IconButton } from "./ui/IconButton";
import { ListItemWorld, ListItemWorldSkeleton } from "./ui/ListColumn";
import { MenuButton } from "./ui/MenuButton";
import { Notices } from "./ui/Notice";
import { Overflow } from "./ui/Overflow";
import { PageHeader } from "./ui/PageHeader";
import { pageOf, Pager, usePage } from "./ui/Pager";
import { TablePreferences, usePageSize } from "./ui/Preferences";
import { Skeleton } from "./ui/Skeleton";
import { useSkeletonRows } from "./ui/rows";
import { Status } from "./ui/Status";
import { nextSort, Table, type Column, type SortDirection } from "./ui/Table";
import { ARRIVED, useArrivals } from "./ui/Tick";
import { Tile, Tiles } from "./ui/Tile";
import { t } from "../../i18n";

/*
 * A state the game home hands to the list it opens (the Worlds by state
 * legend). It rides on the history entry the link creates, so it belongs to
 * that one visit: Back restores it, a link opened in a new tab has none, and
 * a later visit starts unfiltered. Core's router reads no query, so the hash
 * cannot carry it.
 */
const HANDED = "consoleWorldsState";

const HANDED_EVENT = "c-worlds-state";

// The list may render before the entry carries the state, so it is told once the state is there.
function handState(label: string) {
  window.addEventListener("hashchange", () => {
    window.history.replaceState({ ...(window.history.state as object | null), [HANDED]: label }, "");
    window.dispatchEvent(new Event(HANDED_EVENT));
  }, { once: true });
}

function handedState(): string | null {
  if (typeof window === "undefined") return null;
  const value = (window.history.state as Record<string, unknown> | null)?.[HANDED];
  return typeof value === "string" ? value : null;
}

/** The worlds page draws the game home on the overview route and the list everywhere else (M5). */
export function Worlds({ model }: Readonly<{ model: WorldsModel }>) {
  if (model.view === "overview") return <Home model={model} onState={handState} />;
  return <WorldsList model={model} />;
}

type SortKey = "name" | "status" | "players" | "release" | "wipe";
type Sort = Readonly<{ key: SortKey; direction: SortDirection }>;

const sorters: Readonly<Record<SortKey, (a: WorldRow, b: WorldRow) => number>> = {
  name: (a, b) => a.world.displayName.localeCompare(b.world.displayName),
  status: (a, b) => statusRank(a.status) - statusRank(b.status) || a.status.label.localeCompare(b.status.label),
  players: (a, b) => (a.players ?? -1) - (b.players ?? -1),
  release: (a, b) => `${a.presetName} ${a.releaseSummary}`.localeCompare(`${b.presetName} ${b.releaseSummary}`),
  wipe: (a, b) => (a.wipe?.number ?? -1) - (b.wipe?.number ?? -1),
};


// Values the property filter reads from a row, by property id.
function propertyOf(row: WorldRow, property: string): string {
  switch (property) {
    case "status": return row.status.label;
    case "hosting": return hostingLabel(row);
    case "preset": return row.presetName;
    case "release": return row.world.release.activeRelease ?? "—";
    case "connection": return connectionLabel(row.world.connectivity);
    default: return "";
  }
}

const textOf = (row: WorldRow) => `${row.world.displayName} ${row.presetName} ${row.releaseSummary} ${row.address?.value ?? ""}`;

const PROPERTIES: readonly Readonly<{ id: string; label: string }>[] = [
  { id: "status", label: t("common.status") },
  { id: "hosting", label: t("world.hosting") },
  { id: "preset", label: t("common.preset") },
  { id: "release", label: t("common.release") },
  { id: "connection", label: t("world.connection") },
];

/**
 * The Worlds list (spec §6.2): status tiles, the property filter, a table
 * with selection and bulk Actions, and the quick look beside it. Under
 * 1024px the table gives way to the list rows.
 */
function WorldsList({ model }: Readonly<{ model: WorldsModel }>) {
  const [state, setState] = useState<string | null>(handedState);
  useEffect(() => {
    const take = () => { const handed = handedState(); if (handed !== null) setState(handed); };
    take();
    window.addEventListener(HANDED_EVENT, take);
    return () => window.removeEventListener(HANDED_EVENT, take);
  }, []);
  const [tokens, setTokens] = useState<readonly FilterToken[]>([]);
  const [sort, setSort] = useState<Sort>({ key: "name", direction: "ascending" });
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [peekId, setPeekId] = useState<string | null>(null);
  const [size, setSize] = usePageSize();
  const game = model.game;

  // A status token is the pressed tile, never a second mark in the filter box (R3).
  const filter = (next: readonly FilterToken[]) => {
    const status = next.find((token) => token.property === "status");
    if (status) setState(status.value);
    setTokens(next.filter((token) => token.property !== "status"));
  };
  const clear = () => { setTokens([]); setState(null); };

  const rows = model.rows;
  const shown = useMemo(() => {
    const matching = applyFilter(rows, tokens, propertyOf, textOf).filter((row) => state === null || row.status.label === state);
    const order = sorters[sort.key];
    return matching.sort((a, b) => (sort.direction === "ascending" ? 1 : -1) * order(a, b));
  }, [rows, tokens, state, sort]);
  const [page, setPage] = usePage(shown.length);
  const paged = pageOf(shown, page, size);
  // A9 over every world of the game, not the shown page: a page turn or a filter change brings no "new" rows.
  const arrived = useArrivals(rows.map((row) => row.world.id));
  // Bulk Actions reach only what the person can see: a filter or a tile hides a selected world from them too.
  const selected = shown.filter((row) => chosen.has(row.world.id));
  const peek = rows.find((row) => row.world.id === peekId) ?? null;

  const properties: FilterProperty[] = PROPERTIES.map((property) => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(propertyOf(row, property.id), (counts.get(propertyOf(row, property.id)) ?? 0) + 1);
    return { ...property, values: [...counts].map(([value, count]) => ({ value, count })) };
  });

  const toggle = (id: string, on: boolean) => setChosen((current) => {
    const next = new Set(current);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const pageIds = paged.rows.map((row) => row.world.id);
  const onPage = pageIds.filter((id) => chosen.has(id)).length;
  const sortable = (key: SortKey) => ({
    sort: sort.key === key ? sort.direction : null,
    onSort: () => setSort({ key, direction: sort.key === key ? nextSort(sort.direction) : "ascending" }),
  });
  const create = model.createWorld;
  // While the first read runs, the page is the loaded one with placeholders in the table and the tiles.
  const loading = model.status === "loading" && rows.length === 0;
  const states = statesOf(rows);
  const stateTiles = useSkeletonRows(t("world.worldsStates"), states.length, loading);
  const listRows = useSkeletonRows(t("common.worlds"), paged.rows.length, loading);
  const header = (count: number | undefined, start?: ReactNode, creates = true) => (
    <PageHeader
      actions={<>
        {start}
        {create && creates && <ActionButton action={create} variant="primary" />}
      </>}
      count={count}
      title={t("common.worlds")}
      trail={game ? [{ label: game.displayName, href: model.views?.overview ?? "#/home", game: true }] : []}
    />
  );

  if (model.unavailable) {
    return (
      <div className="c-page">
        {header(undefined)}
        <Card label={t("common.games")}>
          <GamesEmpty refresh={model.refresh} unavailable={model.unavailable} />
        </Card>
      </div>
    );
  }
  if (model.status === "error" && rows.length === 0) {
    return (
      <div className="c-page">
        {header(undefined)}
        <Card label={t("world.worldsTable")}><LoadError error={model.error} kind={model.errorKind} retry={withIcon(model.refresh, "refresh")} title={t("common.worldsCouldNotLoaded")} verb={t("common.viewWorlds")} /></Card>
      </div>
    );
  }
  if (rows.length === 0 && !loading) {
    return (
      <div className="c-page">
        {header(0, undefined, false)}
        <Notices notices={model.notices} />
        <Card label={t("world.worldsTable")}>
          <Empty action={create} icon="public" message={create ? undefined : model.emptyDescription ?? undefined} title={t("common.noWorlds")} />
        </Card>
      </div>
    );
  }

  const columns: Column<WorldRow>[] = [
    {
      id: "select",
      header: t("world.select"),
      kind: "check",
      headerCell: <Checkbox checked={pageChecked(onPage, pageIds.length)} label={t("world.selectAllPage")} labelHidden onChange={(on) => setChosen((current) => { const next = new Set(current); for (const id of pageIds) { if (on) next.add(id); else next.delete(id); } return next; })} />,
      render: (row) => <Checkbox checked={chosen.has(row.world.id)} label={t("world.selectWorldDisplayName", { worldDisplayName: row.world.displayName })} labelHidden onChange={(on) => toggle(row.world.id, on)} />,
    },
    { id: "name", header: t("common.name"), kind: "lead", ...sortable("name"), render: (row) => <span className="c-worlds-name"><a href={row.href} title={row.world.displayName}>{row.world.displayName}</a><HostingMark className="c-worlds-hostmark" row={row} /></span> },
    { id: "status", header: t("common.status"), ...sortable("status"), render: (row) => <Status status={row.status} /> },
    { id: "players", header: t("common.players"), kind: "num", ...sortable("players"), render: (row) => <Players count={row.players} /> },
    { id: "release", header: t("world.presetRelease"), clip: true, ...sortable("release"), render: (row) => <ReleaseCell row={row} /> },
    { id: "wipe", header: t("common.wipe"), kind: "num", ...sortable("wipe"), render: (row) => row.wipe ? `#${row.wipe.number}` : <span className="c-faint">{row.wipeAbsent}</span> },
    { id: "hosting", header: t("world.hosting"), className: "c-worlds-host", render: (row) => <HostingChip row={row} /> },
    { id: "address", header: t("common.address"), kind: "optional", render: (row) => row.address ? <Address address={row.address} copy /> : <span className="c-faint">{row.addressAbsent}</span> },
    {
      id: "actions",
      header: t("common.actions"),
      kind: "act",
      render: (row) => <span className="c-worlds-acts"><QuickLookButton onPeek={setPeekId} open={peekId === row.world.id} row={row} /><Overflow actions={row.sessionAction ? [row.sessionAction(), ...row.actions] : row.actions} label={t("common.moreLabel", { label: row.world.displayName })} size="sm" /></span>,
    },
  ];
  const noMatches = <Empty action={action("worlds.filter.clear", t("common.clearFilters"), clear, { icon: "filter_alt_off" })} icon="filter_alt_off" title={t("common.noMatches")} />;

  return (
    <div className="c-page">
      {header(loading ? undefined : rows.length, <BulkActions clear={() => setChosen(new Set())} rows={selected} />)}
      <Notices notices={model.notices} />
      <Tiles label={t("world.filterByStatus")}>
        {loading
          ? Array.from({ length: stateTiles }, (_, tile) => <Skeleton height="var(--c-tile)" key={tile} />)
          : states.map(({ status, count }) => (
            <Tile count={count} key={status.label} onPress={() => setState(state === status.label ? null : status.label)} pressed={state === status.label} status={status} />
          ))}
      </Tiles>
      <div className={peek ? "c-worlds-layout c-worlds-layout-open" : "c-worlds-layout"}>
        <Card body="flush" label={t("world.worldsTable")}>
          <FilterBar
            end={<>
              {paged.pages > 1 && <><Pager onPage={setPage} page={paged.page} pages={paged.pages} /><span aria-hidden="true" className="c-worlds-sep" /></>}
              <TablePreferences pageSize={{ value: size, set: setSize }} />
            </>}
            label={t("world.filterWorldsByProperty")}
            matches={shown.length}
            onChange={filter}
            placeholder={t("world.filterByPropertyText")}
            properties={properties}
            tokens={tokens}
          />
          <Table
            className="c-worlds-table"
            columns={columns}
            empty={noMatches}
            label={t("common.worlds")}
            loading={loading}
            rowKey={(row) => row.world.id}
            arrivals={arrived}
            rows={paged.rows}
            selected={(row) => chosen.has(row.world.id) || peekId === row.world.id}
            split={peek !== null}
          />
          <div className="c-worlds-list">
            {loading && (
              <ul aria-busy="true" aria-label={t("common.loading")} className="c-worlds-rows">
                {Array.from({ length: listRows }, (_, row) => (
                  <li className="c-worlds-row" key={row}>
                    <Skeleton height={20} width={20} />
                    <ListItemWorldSkeleton standalone />
                    <Skeleton height="var(--c-ctl-sm)" width="var(--c-ctl-sm)" />
                  </li>
                ))}
              </ul>
            )}
            {!loading && (paged.rows.length === 0 ? noMatches : <ul className="c-worlds-rows">{paged.rows.map((row) => (
              <li className={cx("c-worlds-row", (chosen.has(row.world.id) || peekId === row.world.id) && "c-worlds-row-selected", arrived.has(row.world.id) && ARRIVED)} key={row.world.id}>
                <Checkbox checked={chosen.has(row.world.id)} label={t("world.selectWorldDisplayName", { worldDisplayName: row.world.displayName })} labelHidden onChange={(on) => toggle(row.world.id, on)} />
                <ListItemWorld
                  address={row.address ? <Address address={row.address} /> : undefined}
                  current={false}
                  hosting={<HostingChip row={row} />}
                  href={row.href}
                  line={releaseLine(row)}
                  name={row.world.displayName}
                  players={row.players ?? null}
                  standalone
                  status={row.status}
                />
                <QuickLookButton onPeek={setPeekId} open={peekId === row.world.id} row={row} />
              </li>
            ))}</ul>)}
          </div>
        </Card>
        {peek && <QuickLook model={model} onClose={() => setPeekId(null)} row={peek} />}
      </div>
    </div>
  );
}

function ReleaseCell({ row }: Readonly<{ row: WorldRow }>) {
  const { activeRelease, desiredRelease } = row.world.release;
  return (
    <span className="c-worlds-release">
      <span className="c-mono" title={`${row.presetName} · ${row.releaseSummary}`}>{row.presetName} · {row.releaseSummary}</span>
      {desiredRelease !== null && desiredRelease !== activeRelease && <Chip tip={t("common.desiredDesiredRelease", { desiredRelease })}>→ {desiredRelease}</Chip>}
    </span>
  );
}

function QuickLookButton({ row, open, onPeek }: Readonly<{ row: WorldRow; open: boolean; onPeek: (id: string | null) => void }>) {
  return <IconButton aria-pressed={open} className="c-icon-btn-sm" icon="view_sidebar" label={t("world.quickLookWorldDisplayName", { worldDisplayName: row.world.displayName })} onClick={() => onPeek(open ? null : row.world.id)} />;
}

/** The header checkbox: none, all or some of the page selected. */
function pageChecked(selected: number, total: number): boolean | "mixed" {
  if (selected === 0) return false;
  return selected === total ? true : "mixed";
}

/** Why a bulk action waits: nothing fits it, or more than one world does. */
function bulkHint(count: number, none: string): string | undefined {
  if (count === 0) return none;
  return count > 1 ? t("world.selectOneWorldConfirm") : undefined;
}

/**
 * The bulk menu. Core confirms one world at a time (a second confirmation
 * replaces the first), so each item runs only when one selected world can
 * take it, and says so when more can.
 */
function BulkActions({ rows, clear }: Readonly<{ rows: readonly WorldRow[]; clear: () => void }>) {
  const verbs = rows.map((row) => ({ row, session: row.sessionAction?.() ?? null }));
  const item = (key: string, label: string, icon: Action["icon"], picked: readonly Action[], none: string) => action(`worlds.bulk.${key}`, label, () => picked[0]?.run(), {
    icon,
    detail: t("world.pickedCountRowCount", { pickedCount: picked.length, rowCount: rows.length }),
    disabled: picked.length !== 1,
    hint: bulkHint(picked.length, none),
  });
  const usable = (candidate: Action | null | undefined, verb: string): candidate is Action => candidate?.id === verb && !candidate.disabled;
  const starts = verbs.flatMap(({ session }) => usable(session, "session.start") ? [session] : []);
  const stops = verbs.flatMap(({ session }) => usable(session, "session.stop") ? [session] : []);
  const archives = rows.flatMap((row) => { const archive = row.actions.find((candidate) => candidate.id === "world.archive"); return usable(archive, "world.archive") ? [archive] : []; });
  return (
    <MenuButton
      disabled={rows.length === 0}
      groups={[
        { actions: [item("start", t("common.start"), "play_arrow", starts, t("world.noSelectedWorldCan")), item("stop", t("common.stop"), "stop", stops, t("world.noSelectedWorldOnline")), item("archive", t("world.archive"), "archive", archives, t("world.onlyStoppedWorldsCan"))] },
        { actions: [action("worlds.bulk.clear", t("common.clearSelection"), clear, { icon: "close" })] },
      ]}
      hint={rows.length === 0 ? t("world.selectWorldsFirst") : undefined}
      id="worlds.bulk"
      label={rows.length > 0 ? t("world.actionsRowCount", { rowCount: rows.length }) : t("common.actions")}
    />
  );
}

/**
 * The quick look: beside the table from 1200px, a sheet over it below. In
 * the split the table row beside it shows the state, so the head does not
 * (R3); the sheet covers the table, so its head does.
 */
function QuickLook({ model, row, onClose }: Readonly<{ model: WorldsModel; row: WorldRow; onClose: () => void }>) {
  const now = useNow(Boolean(row.launchedAt) || (model.operations ?? []).some((item) => item.operation.worldId === row.world.id));
  const panel = useRef<HTMLElement>(null);
  // The opener is kept from the first open only: moving the panel to another row keeps focus where the person put it.
  useEffect(() => {
    const opener = document.activeElement;
    if (window.matchMedia?.("(max-width: 1199px)").matches) panel.current?.querySelector<HTMLElement>(".c-worlds-peek-close")?.focus();
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A menu, dialog or field takes its own Escape first.
      if (event.target instanceof Element && event.target.closest("[role=menu], [role=listbox], dialog, input, textarea, select")) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const operation = (model.operations ?? []).find((item) => item.operation.worldId === row.world.id);
  const uptime = formatUptime(row.launchedAt, now);
  const details: Detail[] = [
    { key: "players", label: t("world.playersOnline"), value: row.players === null || row.players === undefined ? { type: "absent", text: "—" } : { type: "number", value: row.players } },
    { key: "launched", label: t("common.uptime"), value: uptime === null ? { type: "absent", text: "—" } : { type: "text", text: uptime, mono: true } },
    { key: "hosting", label: t("world.hosting"), value: { type: "text", text: hostingLabel(row) } },
    { key: "release", label: t("common.release"), value: { type: "release", active: row.world.release.activeRelease, desired: row.world.release.desiredRelease } },
    { key: "wipe", label: t("world.currentWipe"), value: row.wipe ? { type: "text", text: `#${row.wipe.number}` } : { type: "absent", text: row.wipeAbsent } },
    ...(operation ? [{ label: t("common.operation"), value: { type: "text", text: [operation.operation.id, elapsed(operation.operation.startedAt, now) ?? "", eta(operation.operation.startedAt, operation.operation, now)?.text].filter(Boolean).join(" · "), mono: true } } satisfies Detail] : []),
    { key: "address", label: t("common.address"), value: row.address ? { type: "address", address: row.address } : { type: "absent", text: row.addressAbsent } },
  ];
  return (
    <>
      <div aria-hidden="true" className="c-worlds-scrim" onClick={onClose} />
      <aside aria-label={t("world.quickLookWorldDisplayName2", { worldDisplayName: row.world.displayName })} className="c-worlds-peek" ref={panel}>
        <Card
          actions={<>
            <Status className="c-worlds-peek-status" status={row.status} variant="pill" />
            <IconButton className="c-worlds-peek-close" icon="close" label={t("world.closeQuickLook")} onClick={onClose} />
          </>}
          body="flush"
          title={row.world.displayName}
        >
          <div className="c-worlds-peek-acts">
            {row.sessionAction && <ActionButton action={row.sessionAction()} size="sm" />}
            <LinkButton href={row.href} icon="open_in_new" label={t("world.open")} size="sm" />
          </div>
          <DetailList columns="two" details={details} label={t("world.worldDisplayNameGlance", { worldDisplayName: row.world.displayName })} spans={{ address: "full", Operation: "full" }} />
        </Card>
      </aside>
    </>
  );
}
