import type { Action } from "../../core/actions";
import type { OperationRow, RequestSummary, WorldRow, WorldsModel } from "../../core/models";
import { routeHash } from "../../routing";
import { HostingChip, Players, Uptime, statesOf } from "./WorldFacts";
import { ActionButton, LinkButton } from "./ui/ActionButton";
import { Address } from "./ui/Address";
import { Ago } from "./ui/Ago";
import { Card } from "./ui/Card";
import { Empty, LoadError } from "./ui/Empty";
import { elapsed, useNow } from "./ui/Flashbar";
import { GameGlyph } from "./ui/GameGlyph";
import { Grid, GridCell } from "./ui/Grid";
import { Notices } from "./ui/Notice";
import { PageHeader } from "./ui/PageHeader";
import { Person } from "./ui/Person";
import { SkeletonRows } from "./ui/Skeleton";
import { Status } from "./ui/Status";
import { Tick } from "./ui/Tick";
import { TrackList, TrackTitle } from "./ui/TrackList";
import { providerIcon } from "./providers";

/** A refresh drawn as an icon needs one even when the model gave it none. */
export function withIcon(action: Action, icon: Action["icon"]): Action {
  return action.icon ? action : { ...action, icon };
}

/**
 * The game home (spec §6.1): what runs, what can start, what is under way,
 * builds, requests and the worlds by state. Every card is a list on shared
 * tracks with its title at the start and its link at the end edge.
 */
export function Home({ model, onState }: Readonly<{ model: WorldsModel; /** Opens the list filtered by one state. */ onState: (label: string) => void }>) {
  const game = model.game;
  const list = model.views?.list ?? "#/worlds";
  const empty = model.status === "ready" && model.rows.length === 0;
  const header = (
    <PageHeader
      actions={<>
        <LinkButton href={list} icon="table_rows" label="All worlds" />
        {model.createWorld && !empty && <ActionButton action={model.createWorld} variant="primary" />}
      </>}
      lead={game && <GameGlyph game={game} size="lg" />}
      title={game?.displayName ?? "Home"}
    />
  );
  if (model.unavailable) {
    return (
      <div className="c-page">
        {header}
        <Card label="Games">
          {model.unavailable.failed
            ? <Empty action={model.refresh} icon="error" message={model.unavailable.description} title="Games could not be loaded" tone="error" />
            : <Empty icon="public" message={model.unavailable.description} title="No games yet" />}
        </Card>
      </div>
    );
  }
  if (model.status === "error" && model.rows.length === 0) {
    return (
      <div className="c-page">
        {header}
        <Card label="Worlds"><Empty action={model.refresh} icon="cloud_off" message={model.error} title="Worlds could not be loaded" tone="error" /></Card>
      </div>
    );
  }
  if (empty) {
    return (
      <div className="c-page">
        {header}
        <Notices notices={model.notices} />
        <Card label="Worlds"><Empty action={model.createWorld} icon="public" title="No worlds" /></Card>
      </div>
    );
  }
  const loading = model.status === "loading";
  const online = model.rows.filter((row) => row.status.kind === "ok");
  const startable = model.rows.flatMap((row) => {
    const verb = row.sessionAction?.();
    return verb?.id === "session.start" ? [{ row, verb }] : [];
  });
  const operations = model.operations ?? [];
  const builds = model.builds ?? [];
  const known = online.filter((row) => row.players !== null && row.players !== undefined);
  const players = known.reduce((sum, row) => sum + (row.players ?? 0), 0);
  const releases = routeHash({ page: "releases", accessTab: "users", gameId: game?.id ?? null, worldId: null });
  return (
    <div className="c-page">
      {header}
      <Notices notices={model.notices} />
      <Grid kind="home">
        <GridCell span="2">
          <Card
            actions={<LinkButton href={list} label="Worlds" size="sm" variant="ghost" />}
            body="flush"
            count={online.length}
            meta={known.length > 0 && <><Tick value={players} /> {players === 1 ? "player" : "players"}</>}
            title="Online now"
          >
            {loading ? <SkeletonRows columns={4} rows={3} /> : (
              <TrackList
                arrivals
                empty={<Empty icon="bedtime" size="sm" title="Nothing online" />}
                label="Online now"
                rowKey={(row) => row.world.id}
                rows={online}
                tracks={[
                  { id: "world", header: "World", width: "minmax(180px, 1fr)", compactWidth: "minmax(0, 1fr)", kind: "stack", render: (row) => (
                    // Under 1024px the Address track drops; the address and its copy take a third line of their own (spec §6.1).
                    <span className="c-home-world">
                      <TrackTitle href={row.href} line={<><HostingChip row={row} /><span className="c-mono">{row.releaseSummary}</span></>} title={row.world.displayName} />
                      {row.address && <span className="c-home-world-address"><Address address={row.address} copy /></span>}
                    </span>
                  ) },
                  { id: "uptime", header: "Uptime", width: "110px", kind: "optional", render: (row) => <Uptime since={row.launchedAt} /> },
                  { id: "address", header: "Address", width: "minmax(260px, 1.6fr)", kind: "optional", render: (row) => row.address ? <Address address={row.address} copy /> : <span className="c-faint">{row.addressAbsent}</span> },
                  { id: "players", header: "Players", width: "80px", compactWidth: "auto", kind: "num", render: (row) => <Players count={row.players} /> },
                ]}
              />
            )}
          </Card>
        </GridCell>
        <Card body="flush" count={startable.length} title="Start a world">
          {loading ? <SkeletonRows columns={3} rows={3} /> : (
            <TrackList
              empty={<Empty icon="check" size="sm" title="Every world is running" />}
              label="Start a world"
              rowKey={({ row }) => row.world.id}
              rows={startable}
              tracks={[
                { id: "world", header: "World", width: "minmax(0, 1fr)", kind: "stack", render: ({ row }) => <TrackTitle href={row.href} line={<HostingChip row={row} />} title={row.world.displayName} /> },
                { id: "state", header: "State", width: "auto", render: ({ row }) => <Status status={row.status} /> },
                { id: "act", header: "Action", width: "auto", kind: "end", quietHeader: true, render: ({ verb }) => <ActionButton action={verb} size="sm" /> },
              ]}
            />
          )}
        </Card>
        <Card body="flush" count={operations.length} title="Operations">
          <TrackList
            arrivals
            empty={<Empty icon="done_all" size="sm" title="No operations running" />}
            label="Operations"
            rowKey={(row) => row.operation.id}
            rows={operations}
            tracks={[
              { id: "operation", header: "Operation", width: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle href={row.href} line={<span className="c-mono">{row.operation.id}</span>} title={`${row.label} · ${row.worldName}`} /> },
              { id: "running", header: "Running for", width: "auto", kind: "num", render: (row) => <RunningFor row={row} /> },
            ]}
          />
        </Card>
        {builds.length > 0 && (
          <GridCell span="2-wide">
            <Card actions={<LinkButton href={releases} label="Releases" size="sm" variant="ghost" />} body="flush" title="Release builds">
              <TrackList
                label="Release builds"
                rowKey={(row) => row.preset.id}
                rows={builds}
                tracks={[
                  { id: "preset", header: "Preset", width: "minmax(0, 1.2fr)", compactWidth: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle compactLine={row.preset.latestRelease ?? undefined} title={row.preset.displayName} /> },
                  { id: "latest", header: "Latest release", width: "minmax(0, 1fr)", kind: "optional", render: (row) => row.preset.latestRelease ? <span className="c-mono">{row.preset.latestRelease}</span> : <span className="c-faint">—</span> },
                  { id: "build", header: "Build", width: "auto", kind: "end", render: (row) => <Status status={row.status} /> },
                ]}
              />
            </Card>
          </GridCell>
        )}
        {model.requests && <Requests model={model} requests={model.requests} />}
        <GridCell span="full">
          <Card count={model.rows.length} title="Worlds by state">
            <ByState list={list} onState={onState} rows={model.rows} />
          </Card>
        </GridCell>
      </Grid>
    </div>
  );
}

function RunningFor({ row }: Readonly<{ row: OperationRow }>) {
  const now = useNow();
  return <span className="c-mono">{elapsed(row.operation.startedAt, now) ?? "—"}</span>;
}

function Requests({ model, requests }: Readonly<{ model: WorldsModel; requests: NonNullable<WorldsModel["requests"]> }>) {
  const access = routeHash({ page: "access", accessTab: "users", gameId: null, worldId: null });
  const verbs = (row: RequestSummary) => model.requestActions?.(row.id) ?? null;
  return (
    <GridCell span="2-wide">
      <Card actions={<LinkButton href={access} label="Access" size="sm" variant="ghost" />} body="flush" count={requests.status === "ready" ? requests.value.length : undefined} title="Access requests">
        {requests.status === "loading" && <SkeletonRows columns={2} rows={2} />}
        {requests.status === "error" && <LoadError error={requests.error} kind={requests.kind} retry={requests.retry} size="sm" title="Requests could not be loaded" verb="read requests" />}
        {requests.status === "ready" && (
          <TrackList
            arrivals
            empty={<Empty icon="how_to_reg" size="sm" title="No requests" />}
            label="Access requests"
            rowKey={(row) => row.id}
            rows={requests.value}
            tracks={[
              { id: "person", header: "Person", width: "minmax(0, 1fr)", kind: "stack", render: (row) => <Person detail={row.account} detailIcon={providerIcon(row.platform)} name={row.displayName} photoUrl={row.photoUrl} tone="request" /> },
              { id: "since", header: "Requested", width: "auto", kind: "optional", render: (row) => <Ago at={row.since} /> },
              { id: "decide", header: "Decision", width: "auto", kind: "end", quietHeader: true, render: (row) => {
                const pair = verbs(row);
                return pair && <span className="c-home-decide"><ActionButton action={pair.approve} size="sm" /><ActionButton action={pair.dismiss} iconOnly size="sm" /></span>;
              } },
            ]}
          />
        )}
      </Card>
    </GridCell>
  );
}

/** The game's worlds by state: one stacked bar and a legend spread across the row, each entry opening the list filtered by it. */
function ByState({ rows, list, onState }: Readonly<{ rows: readonly WorldRow[]; list: string; onState: (label: string) => void }>) {
  const states = statesOf(rows);
  return (
    <div className="c-bystate">
      <div aria-label={states.map(({ status, count }) => `${count} ${status.label}`).join(", ")} className="c-bystate-bar" role="img">
        {states.map(({ status, count }) => <i className={`c-bystate-seg c-bystate-${status.kind}`} key={status.label} style={{ flexGrow: count }} />)}
      </div>
      <div className="c-bystate-legend">
        {states.map(({ status, count }) => (
          <a href={list} key={status.label} onClick={() => onState(status.label)}>
            {/* The key wears its segment's fill, so it reads like the bar. */}
            <i aria-hidden="true" className={`c-bystate-seg c-bystate-key c-bystate-${status.kind}`} />
            <span>{status.label}</span>
            <b>{count}</b>
          </a>
        ))}
      </div>
    </div>
  );
}
