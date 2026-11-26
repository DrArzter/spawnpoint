import type { Action } from "../../core/actions";
import type { RequestSummary, WorldRow, WorldsModel } from "../../core/models";
import { routeHash } from "../../routing";
import { BuildState } from "./BuildState";
import { HostingChip, Players, Uptime, statesOf } from "./WorldFacts";
import { Decision } from "./ui/Decision";
import { ActionButton, LinkButton } from "./ui/ActionButton";
import { Address } from "./ui/Address";
import { Ago } from "./ui/Ago";
import { Card } from "./ui/Card";
import { Empty, GamesEmpty, LoadError } from "./ui/Empty";
import { RunningTime } from "./ui/Flashbar";
import { GameGlyph } from "./ui/GameGlyph";
import { Grid, GridCell } from "./ui/Grid";
import { Notices } from "./ui/Notice";
import { PageHeader } from "./ui/PageHeader";
import { Person } from "./ui/Person";
import { Status } from "./ui/Status";
import { Tick } from "./ui/Tick";
import { TrackList, TrackTitle } from "./ui/TrackList";
import { providerIcon } from "./providers";
import { t } from "../../i18n";

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
        <LinkButton href={list} icon="table_rows" label={t("app.allWorlds")} />
        {model.createWorld && !empty && <ActionButton action={model.createWorld} variant="primary" />}
      </>}
      lead={game && <GameGlyph game={game} size="lg" />}
      title={game?.displayName ?? t("shell.home")}
    />
  );
  if (model.unavailable) {
    return (
      <div className="c-page">
        {header}
        <Card label={t("common.games")}>
          <GamesEmpty refresh={model.refresh} unavailable={model.unavailable} />
        </Card>
      </div>
    );
  }
  if (model.status === "error" && model.rows.length === 0) {
    return (
      <div className="c-page">
        {header}
        <Card label={t("common.worlds")}><LoadError error={model.error} kind={model.errorKind} retry={model.refresh} title={t("common.worldsCouldNotLoaded")} verb={t("common.viewWorlds")} /></Card>
      </div>
    );
  }
  if (empty) {
    return (
      <div className="c-page">
        {header}
        <Notices notices={model.notices} />
        <Card label={t("common.worlds")}><Empty action={model.createWorld} icon="public" title={t("common.noWorlds")} /></Card>
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
            actions={<LinkButton href={list} label={t("common.worlds")} size="sm" variant="ghost" />}
            body="flush"
            count={online.length}
            meta={known.length > 0 && <><Tick value={players} /> {t("common.playersWord", { count: players })}</>}
            title={t("app.onlineNow")}
          >
            <TrackList
                arrivals
                empty={<Empty icon="bedtime" size="sm" title={t("app.nothingOnline")} />}
                label={t("app.onlineNow")}
                loading={loading}
                rowKey={(row) => row.world.id}
                rows={online}
                tracks={[
                  { id: "world", header: t("common.world"), width: "minmax(180px, 1fr)", compactWidth: "minmax(0, 1fr)", kind: "stack", render: (row) => (
                    // Under 1024px the Address track drops; the address and its copy take a third line of their own (spec §6.1).
                    <span className="c-home-world">
                      <TrackTitle href={row.href} line={<><HostingChip row={row} /><span className="c-mono">{row.releaseSummary}</span></>} title={row.world.displayName} />
                      {row.address && <span className="c-home-world-address"><Address address={row.address} copy /></span>}
                    </span>
                  ) },
                  { id: "uptime", header: t("common.uptime"), width: "110px", kind: "optional", render: (row) => <Uptime since={row.launchedAt} /> },
                  { id: "address", header: t("common.address"), width: "minmax(260px, 1.6fr)", kind: "optional", render: (row) => row.address ? <Address address={row.address} copy /> : <span className="c-faint">{row.addressAbsent}</span> },
                  { id: "players", header: t("common.players"), width: "80px", compactWidth: "auto", kind: "num", render: (row) => <Players count={row.players} /> },
                ]}
            />
          </Card>
        </GridCell>
        <Card body="flush" count={startable.length} title={t("app.startWorld")}>
          <TrackList
              empty={<Empty icon="check" size="sm" title={t("app.everyWorldRunning")} />}
              label={t("app.startWorld")}
              loading={loading}
              rowKey={({ row }) => row.world.id}
              rows={startable}
              tracks={[
                { id: "world", header: t("common.world"), width: "minmax(0, 1fr)", kind: "stack", render: ({ row }) => <TrackTitle href={row.href} line={<HostingChip row={row} />} title={row.world.displayName} /> },
                { id: "state", header: t("common.state"), width: "auto", render: ({ row }) => <Status status={row.status} /> },
                { id: "act", header: t("common.action"), width: "auto", kind: "end", quietHeader: true, render: ({ verb }) => <ActionButton action={verb} size="sm" /> },
              ]}
            />
        </Card>
        <Card body="flush" count={operations.length} title={t("common.operations")}>
          <TrackList
            arrivals
            empty={<Empty icon="done_all" size="sm" title={t("app.noOperationsRunning")} />}
            label={t("common.operations")}
            rowKey={(row) => row.operation.id}
            rows={operations}
            tracks={[
              { id: "operation", header: t("common.operation"), width: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle href={row.href} line={<span className="c-mono">{row.operation.id}</span>} title={`${row.label} · ${row.worldName}`} /> },
              { id: "running", header: t("common.running2"), width: "auto", kind: "num", render: (row) => <RunningTime expectation={row.operation} since={row.operation.startedAt} /> },
            ]}
          />
        </Card>
        {builds.length > 0 && (
          <GridCell span="2-wide">
            <Card actions={<LinkButton href={releases} label={t("common.releases")} size="sm" variant="ghost" />} body="flush" title={t("app.releaseBuilds")}>
              <TrackList
                label={t("app.releaseBuilds")}
                rowKey={(row) => row.preset.id}
                rows={builds}
                tracks={[
                  { id: "preset", header: t("common.preset"), width: "minmax(0, 1.2fr)", compactWidth: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle compactLine={row.preset.latestRelease ?? undefined} title={row.preset.displayName} /> },
                  { id: "latest", header: t("common.latestRelease"), width: "minmax(0, 1fr)", kind: "optional", render: (row) => row.preset.latestRelease ? <span className="c-mono">{row.preset.latestRelease}</span> : <span className="c-faint">—</span> },
                  { id: "build", header: t("common.build"), width: "auto", kind: "end", render: (row) => <BuildState row={row} /> },
                ]}
              />
            </Card>
          </GridCell>
        )}
        {model.requests && <Requests model={model} requests={model.requests} />}
        <GridCell span="full">
          <Card count={model.rows.length} title={t("app.worldsByState")}>
            <ByState list={list} onState={onState} rows={model.rows} />
          </Card>
        </GridCell>
      </Grid>
    </div>
  );
}

function Requests({ model, requests }: Readonly<{ model: WorldsModel; requests: NonNullable<WorldsModel["requests"]> }>) {
  const access = routeHash({ page: "access", accessTab: "users", gameId: null, worldId: null });
  const verbs = (row: RequestSummary) => model.requestActions?.(row.id) ?? null;
  return (
    <GridCell span="2-wide">
      <Card actions={<LinkButton href={access} label={t("common.access")} size="sm" variant="ghost" />} body="flush" count={requests.status === "ready" ? requests.value.length : undefined} title={t("common.accessRequests")}>
        {requests.status === "error" && <LoadError error={requests.error} kind={requests.kind} retry={requests.retry} size="sm" title={t("common.requestsCouldNotLoaded")} verb={t("common.readRequests")} />}
        {requests.status !== "error" && (
          <TrackList
            arrivals
            empty={<Empty icon="how_to_reg" size="sm" title={t("app.noRequests")} />}
            label={t("common.accessRequests")}
            loading={requests.status === "loading"}
            rowKey={(row) => row.id}
            rows={requests.status === "ready" ? requests.value : []}
            tracks={[
              { id: "person", header: t("common.person"), width: "minmax(0, 1fr)", kind: "stack", render: (row) => <Person detail={row.account} detailIcon={providerIcon(row.platform)} name={row.displayName} photoUrl={row.photoUrl} tone="request" /> },
              { id: "since", header: t("common.requested"), width: "auto", kind: "optional", render: (row) => <Ago at={row.since} /> },
              { id: "decide", header: t("app.decision"), width: "auto", kind: "end", quietHeader: true, render: (row) => {
                const pair = verbs(row);
                return pair && <Decision approve={pair.approve} dismiss={pair.dismiss} />;
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
