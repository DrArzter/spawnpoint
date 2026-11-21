import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { action, type Action } from "../../core/actions";
import type { Detail, WorldRow, WorldsModel } from "../../core/models";
import { cx } from "../../lib/cx";
import { Home, withIcon } from "./Home";
import { HostingChip, HostingMark, Players, hostingLabel, releaseLine, statesOf, statusRank, uptimeText } from "./WorldFacts";
import { ActionButton, LinkButton } from "./ui/ActionButton";
import { Address } from "./ui/Address";
import { Card } from "./ui/Card";
import { Chip } from "./ui/Chip";
import { DetailList } from "./ui/DetailList";
import { Empty } from "./ui/Empty";
import { Checkbox } from "./ui/Fields";
import { applyFilter, FilterBar, type FilterProperty, type FilterToken } from "./ui/FilterBar";
import { elapsed, useNow } from "./ui/Flashbar";
import { IconButton } from "./ui/IconButton";
import { ListItemWorld } from "./ui/ListColumn";
import { MenuButton } from "./ui/MenuButton";
import { Notices } from "./ui/Notice";
import { Overflow } from "./ui/Overflow";
import { PageHeader } from "./ui/PageHeader";
import { pageOf, Pager, usePage } from "./ui/Pager";
import { TablePreferences, usePageSize } from "./ui/Preferences";
import { Skeleton, SkeletonGroup } from "./ui/Skeleton";
import { Status } from "./ui/Status";
import { nextSort, Table, type Column, type SortDirection } from "./ui/Table";
import { ARRIVED, useArrivals } from "./ui/Tick";
import { Tile, Tiles } from "./ui/Tile";

/*
 * A state the game home hands to the list it opens (the Worlds by state
 * legend). It rides on the history entry the link creates, so it belongs to
 * that one visit: Back restores it, a link opened in a new tab has none, and
 * a later visit starts unfiltered. Core's router reads no query, so the hash
 * cannot carry it.
 */
const HANDED = "cloudWorldsState";

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

const connections: Readonly<Record<WorldRow["world"]["connectivity"], string>> = { zerotier: "ZeroTier", raw: "Public IP", route53: "DNS" };

// Values the property filter reads from a row, by property id.
function propertyOf(row: WorldRow, property: string): string {
  switch (property) {
    case "status": return row.status.label;
    case "hosting": return hostingLabel(row);
    case "preset": return row.presetName;
    case "release": return row.world.release.activeRelease ?? "—";
    case "connection": return connections[row.world.connectivity];
    default: return "";
  }
}

const textOf = (row: WorldRow) => `${row.world.displayName} ${row.presetName} ${row.releaseSummary} ${row.address?.value ?? ""}`;

const PROPERTIES: readonly Readonly<{ id: string; label: string }>[] = [
  { id: "status", label: "Status" },
  { id: "hosting", label: "Hosting" },
  { id: "preset", label: "Preset" },
  { id: "release", label: "Release" },
  { id: "connection", label: "Connection" },
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
  const header = (count: number | undefined, start?: ReactNode, creates = true) => (
    <PageHeader
      actions={<>
        {start}
        {create && creates && <ActionButton action={create} variant="primary" />}
      </>}
      count={count}
      title="Worlds"
      trail={game ? [{ label: game.displayName, href: model.views?.overview ?? "#/home", game: true }] : []}
    />
  );

  if (model.unavailable) {
    return (
      <div className="c-page">
        {header(undefined)}
        <Card label="Games">
          {model.unavailable.failed
            ? <Empty action={model.refresh} icon="error" message={model.unavailable.description} title="Games could not be loaded" tone="error" />
            : <Empty icon="public" message={model.unavailable.description} title="No games yet" />}
        </Card>
      </div>
    );
  }
  if (model.status === "loading" && rows.length === 0) {
    return (
      <div className="c-page">
        {header(undefined)}
        <SkeletonGroup className="c-worlds-loading">
          <div className="c-tiles">{Array.from({ length: 7 }, (_, index) => <Skeleton height={52} key={index} />)}</div>
        </SkeletonGroup>
        <Card body="flush" label="Worlds table">
          <Table columns={[{ id: "name", header: "Name", kind: "lead", render: () => null }, { id: "status", header: "Status", render: () => null }, { id: "release", header: "Preset · release", render: () => null }, { id: "wipe", header: "Wipe", kind: "num", render: () => null }]} label="Worlds" loading rowKey={() => ""} rows={[]} />
        </Card>
      </div>
    );
  }
  if (model.status === "error" && rows.length === 0) {
    return (
      <div className="c-page">
        {header(undefined)}
        <Card label="Worlds table"><Empty action={withIcon(model.refresh, "refresh")} icon="cloud_off" message={model.error} title="Worlds could not be loaded" tone="error" /></Card>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="c-page">
        {header(0, <ActionButton action={withIcon(model.refresh, "refresh")} iconOnly />, false)}
        <Notices notices={model.notices} />
        <Card label="Worlds table">
          <Empty action={create} icon="public" message={create ? undefined : model.emptyDescription ?? undefined} title="No worlds" />
        </Card>
      </div>
    );
  }

  const columns: Column<WorldRow>[] = [
    {
      id: "select",
      header: "Select",
      kind: "check",
      headerCell: <Checkbox checked={onPage === 0 ? false : onPage === pageIds.length ? true : "mixed"} label="Select all on this page" labelHidden onChange={(on) => setChosen((current) => { const next = new Set(current); for (const id of pageIds) { if (on) next.add(id); else next.delete(id); } return next; })} />,
      render: (row) => <Checkbox checked={chosen.has(row.world.id)} label={`Select ${row.world.displayName}`} labelHidden onChange={(on) => toggle(row.world.id, on)} />,
    },
    { id: "name", header: "Name", kind: "lead", ...sortable("name"), render: (row) => <span className="c-worlds-name"><a href={row.href} title={row.world.displayName}>{row.world.displayName}</a><HostingMark className="c-worlds-hostmark" row={row} /></span> },
    { id: "status", header: "Status", ...sortable("status"), render: (row) => <Status status={row.status} /> },
    { id: "players", header: "Players", kind: "num", ...sortable("players"), render: (row) => <Players count={row.players} /> },
    { id: "release", header: "Preset · release", ...sortable("release"), render: (row) => <ReleaseCell row={row} /> },
    { id: "wipe", header: "Wipe", kind: "num", ...sortable("wipe"), render: (row) => row.wipe ? `#${row.wipe.number}` : <span className="c-faint">{row.wipeAbsent}</span> },
    { id: "hosting", header: "Hosting", className: "c-worlds-host", render: (row) => <HostingChip row={row} /> },
    { id: "address", header: "Address", kind: "optional", render: (row) => row.address ? <Address address={row.address} copy /> : <span className="c-faint">{row.addressAbsent}</span> },
    {
      id: "actions",
      header: "Actions",
      kind: "act",
      render: (row) => <span className="c-worlds-acts"><QuickLookButton onPeek={setPeekId} open={peekId === row.world.id} row={row} /><Overflow actions={row.sessionAction ? [row.sessionAction(), ...row.actions] : row.actions} label={`More for ${row.world.displayName}`} size="sm" /></span>,
    },
  ];
  const states = statesOf(rows);
  const noMatches = <Empty action={action("worlds.filter.clear", "Clear filters", clear, { icon: "filter_alt_off" })} icon="filter_alt_off" title="No matches" />;

  return (
    <div className="c-page">
      {header(rows.length, <BulkActions clear={() => setChosen(new Set())} rows={selected} />)}
      <Notices notices={model.notices} />
      <Tiles label="Filter by status">
        {states.map(({ status, count }) => (
          <Tile count={count} key={status.label} onPress={() => setState(state === status.label ? null : status.label)} pressed={state === status.label} status={status} />
        ))}
      </Tiles>
      <div className={peek ? "c-worlds-layout c-worlds-layout-open" : "c-worlds-layout"}>
        <Card body="flush" label="Worlds table">
          <FilterBar
            end={<>
              {paged.pages > 1 && <><Pager onPage={setPage} page={paged.page} pages={paged.pages} /><span aria-hidden="true" className="c-worlds-sep" /></>}
              <ActionButton action={withIcon(model.refresh, "refresh")} iconOnly />
              <TablePreferences pageSize={{ value: size, set: setSize }} />
            </>}
            label="Filter worlds by property or text"
            matches={shown.length}
            onChange={filter}
            placeholder="Filter by property or text"
            properties={properties}
            tokens={tokens}
          />
          <Table
            className="c-worlds-table"
            columns={columns}
            empty={noMatches}
            label="Worlds"
            rowKey={(row) => row.world.id}
            arrivals={arrived}
            rows={paged.rows}
            selected={(row) => chosen.has(row.world.id) || peekId === row.world.id}
            split={peek !== null}
          />
          <div className="c-worlds-list" role="list">
            {paged.rows.length === 0 ? noMatches : paged.rows.map((row) => (
              <div className={cx("c-worlds-row", (chosen.has(row.world.id) || peekId === row.world.id) && "c-worlds-row-selected", arrived.has(row.world.id) && ARRIVED)} key={row.world.id}>
                <Checkbox checked={chosen.has(row.world.id)} label={`Select ${row.world.displayName}`} labelHidden onChange={(on) => toggle(row.world.id, on)} />
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
              </div>
            ))}
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
      {desiredRelease !== null && desiredRelease !== activeRelease && <Chip tip={`Desired ${desiredRelease}`}>→ {desiredRelease}</Chip>}
    </span>
  );
}

function QuickLookButton({ row, open, onPeek }: Readonly<{ row: WorldRow; open: boolean; onPeek: (id: string | null) => void }>) {
  return <IconButton aria-pressed={open} className="c-icon-btn-sm" icon="view_sidebar" label={`Quick look at ${row.world.displayName}`} onClick={() => onPeek(open ? null : row.world.id)} />;
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
    detail: `${picked.length} of ${rows.length}`,
    disabled: picked.length !== 1,
    hint: picked.length === 0 ? none : picked.length > 1 ? "Select one world to confirm" : undefined,
  });
  const usable = (candidate: Action | null | undefined, verb: string): candidate is Action => candidate !== null && candidate !== undefined && candidate.id === verb && !candidate.disabled;
  const starts = verbs.flatMap(({ session }) => usable(session, "session.start") ? [session] : []);
  const stops = verbs.flatMap(({ session }) => usable(session, "session.stop") ? [session] : []);
  const archives = rows.flatMap((row) => { const archive = row.actions.find((candidate) => candidate.id === "world.archive"); return usable(archive, "world.archive") ? [archive] : []; });
  return (
    <MenuButton
      disabled={rows.length === 0}
      groups={[
        { actions: [item("start", "Start", "play_arrow", starts, "No selected world can start"), item("stop", "Stop", "stop", stops, "No selected world is online"), item("archive", "Archive", "archive", archives, "Only stopped worlds can be archived")] },
        { actions: [action("worlds.bulk.clear", "Clear selection", clear, { icon: "close" })] },
      ]}
      hint={rows.length === 0 ? "Select worlds first" : undefined}
      id="worlds.bulk"
      label={rows.length > 0 ? `Actions (${rows.length})` : "Actions"}
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
  const uptime = uptimeText(row.launchedAt, now);
  const details: Detail[] = [
    { key: "players", label: "Players online", value: row.players === null || row.players === undefined ? { type: "absent", text: "—" } : { type: "number", value: row.players } },
    { key: "launched", label: "Uptime", value: uptime === null ? { type: "absent", text: "—" } : { type: "text", text: uptime, mono: true } },
    { key: "hosting", label: "Hosting", value: { type: "text", text: hostingLabel(row) } },
    { key: "release", label: "Release", value: { type: "release", active: row.world.release.activeRelease, desired: row.world.release.desiredRelease } },
    { key: "wipe", label: "Current wipe", value: row.wipe ? { type: "text", text: `#${row.wipe.number}` } : { type: "absent", text: row.wipeAbsent } },
    ...(operation ? [{ label: "Operation", value: { type: "text", text: `${operation.operation.id} · ${elapsed(operation.operation.startedAt, now) ?? ""}`, mono: true } } satisfies Detail] : []),
    { key: "address", label: "Address", value: row.address ? { type: "address", address: row.address } : { type: "absent", text: row.addressAbsent } },
  ];
  return (
    <>
      <div aria-hidden="true" className="c-worlds-scrim" onClick={onClose} />
      <aside aria-label={`Quick look: ${row.world.displayName}`} className="c-worlds-peek" ref={panel}>
        <Card
          actions={<>
            <Status className="c-worlds-peek-status" status={row.status} variant="pill" />
            <IconButton className="c-worlds-peek-close" icon="close" label="Close quick look" onClick={onClose} />
          </>}
          body="flush"
          title={row.world.displayName}
        >
          <div className="c-worlds-peek-acts">
            {row.sessionAction && <ActionButton action={row.sessionAction()} size="sm" />}
            <LinkButton href={row.href} icon="open_in_new" label="Open" size="sm" />
          </div>
          <DetailList columns="two" details={details} label={`${row.world.displayName} at a glance`} spans={{ address: "full", Operation: "full" }} />
        </Card>
      </aside>
    </>
  );
}
