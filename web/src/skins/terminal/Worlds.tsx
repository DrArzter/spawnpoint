import type { ReactNode } from "react";

import { Timestamp } from "../../components/ui/Timestamp";
import type { Notice as NoticeModel, SessionOverview, WorldRow, WorldsModel } from "../../core/models";
import { formatDateTime, plural } from "../../lib/format";
import { useMediaQuery } from "../../shell/hooks";
import { GameIcon } from "./GameIcon";
import { Address, Col, Empty, Ghost, Help, Indicator, Notice, Overflow, Page, Panel, Skeleton, SkeletonGroup, State, Table, Verb } from "./ui";

// The first screen: the host as the game's icon drawn in glyphs with its
// state beside it, then every world of the scoped game as a row.
export function Worlds({ model }: Readonly<{ model: WorldsModel }>) {
  const loading = model.status === "loading";
  const narrow = useMediaQuery("(max-width: 599px)");
  const title = model.game ? `Worlds of ${model.game.displayName}` : "Worlds";

  if (model.unavailable) {
    return (
      <Page>
        <h1 className="visually-hidden">Worlds</h1>
        <Notices notices={model.notices} />
        <Panel><Empty title="No games to show" /></Panel>
      </Page>
    );
  }

  return (
    <Page>
      <h1 className="visually-hidden">Worlds</h1>
      <Notices notices={model.notices} />
      <Panel className="t-host" name="Host">
        <div aria-busy={loading || undefined} className="t-host-body">
          {!narrow && <GameIcon game={model.game} size="40x18" state={model.overview.state} />}
          {loading ? <HostSkeleton compact={narrow} /> : <HostState compact={narrow} overview={model.overview} />}
        </div>
      </Panel>
      <Panel
        className="t-worlds-list"
        flush
        name={narrow ? "Worlds" : title}
        verbs={<>
          {narrow
            ? <Overflow groups={[[...(model.createWorld ? [model.createWorld] : []), model.refresh]]} label="World actions" size="small" />
            : <>{model.createWorld && <Verb action={model.createWorld} tone="primary" />}<Verb action={model.refresh} /></>}
        </>}
      >
        <Table
          columns={worldColumns}
          empty={<Empty title="No worlds in this game" />}
          label={title}
          loading={loading}
          rowKey={(row) => row.world.id}
          rows={model.rows}
        />
      </Panel>
    </Page>
  );
}

function HostSkeleton({ compact }: Readonly<{ compact: boolean }>) {
  return (
    <SkeletonGroup className="t-host-skeleton" label="Reading the host">
      <Skeleton width="long" />
      <Skeleton width="medium" />
      {!compact && <div className="t-host-skeleton-facts">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} width={index % 2 === 0 ? "medium" : "short"} />)}
      </div>}
    </SkeletonGroup>
  );
}

export const worldColumns: readonly Col<WorldRow>[] = [
  { id: "status", label: "Status", width: "1%", render: (row) => <Indicator kind={row.status.kind} label={row.status.label} /> },
  { id: "name", label: "Name", width: "22%", render: (row) => <a className="t-row-link" href={row.href}>{row.world.displayName}</a> },
  { id: "release", label: "Preset and release", compactBlock: true, width: "24%", render: (row) => <span className="t-stack"><strong>{row.presetName}</strong><small>{row.releaseSummary}</small></span> },
  {
    id: "wipe",
    label: "Wipe",
    width: "20%",
    optional: true,
    render: (row) => row.wipe
      ? <strong>#{row.wipe.number}</strong>
      : <Ghost>{row.wipeAbsent}</Ghost>,
  },
  { id: "address", label: "Address", render: (row) => row.address ? <Address connectivity={row.address.connectivity} copyLabel={`Copy the address of ${row.world.displayName}`} network={row.address.network} size="small" value={row.address.value} /> : <Ghost>{row.addressAbsent}</Ghost> },
  { id: "verbs", label: "Actions", verbs: true, corner: true, render: (row) => <Overflow groups={[row.actions]} label={`More actions for ${row.world.displayName}`} size="small" /> },
];

export function Notices({ notices }: Readonly<{ notices: readonly NoticeModel[] }>) {
  return <>{notices.map((notice) => (
    <Notice description={notice.description} key={notice.id} title={notice.title} tone={notice.tone} verbs={notice.action ? <Verb action={notice.action} size="small" /> : undefined} />
  ))}</>;
}

function HostState({ overview, compact = false }: Readonly<{ overview: SessionOverview; compact?: boolean }>) {
  const host = overview.host;
  if (compact) return (
    <div className="t-host-state t-host-state-compact">
      <span className="t-host-title"><State kind={overview.status.kind} label={overview.headline} size="large" />{!overview.fleet && <Help text={overview.reason.detail} />}</span>
      <p className="t-host-line">
        {overview.players !== null && <span><strong>{plural(overview.players, "player")}</strong> online · </span>}
        <span>observed <strong>{formatDateTime(overview.observedAt)}</strong></span>
      </p>
    </div>
  );
  return (
    <div className="t-host-state">
      <span className="t-host-title"><State kind={overview.status.kind} label={overview.headline} size="large" />{!overview.fleet && <Help text={overview.reason.detail} />}</span>
      <p className="t-host-line">
        {overview.players !== null && <span><strong>{plural(overview.players, "player")}</strong> online · </span>}
        <span>observed <strong>{formatDateTime(overview.observedAt)}</strong></span>
      </p>
      <dl className="t-facts">
        {overview.fleet ? <>
          <Fact label="Fleet hosts">{overview.fleetHosts.running} running</Fact>
          <Fact label="Provisioning">{overview.fleetHosts.pending} hosts</Fact>
        </> : <>
          <Fact label="Compute host">{host ? <><State kind={host.status.kind} label={host.status.label} /><small>{host.name}</small></> : <Ghost>No host available</Ghost>}</Fact>
          <Fact label="Instance type">{host?.instanceType ? <code>{host.instanceType}</code> : <Ghost>Not reported</Ghost>}</Fact>
          <Fact label="Zone">{host?.zone ? <code>{host.zone}</code> : <Ghost>Not reported</Ghost>}</Fact>
          <Fact label="Launched">{host?.launchedAt ? <Timestamp value={host.launchedAt} /> : <Ghost>Not running</Ghost>}</Fact>
        </>}
      </dl>
    </div>
  );
}

function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="t-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
