import type { ReactNode } from "react";

import { Timestamp } from "../../components/ui/Timestamp";
import type { Notice as NoticeModel, SessionOverview, WorldRow, WorldsModel } from "../../core/models";
import { formatDateTime, plural } from "../../lib/format";
import { useMediaQuery } from "../../shell/hooks";
import { GameIcon } from "./GameIcon";
import { Address, Col, Empty, Ghost, Help, Indicator, Notice, Overflow, Page, Panel, Skeleton, SkeletonGroup, State, Table, Verb } from "./ui";
import { rich, t } from "../../i18n";

// The first screen: the host as the game's icon drawn in glyphs with its
// state beside it, then every world of the scoped game as a row.
export function Worlds({ model }: Readonly<{ model: WorldsModel }>) {
  const loading = model.status === "loading";
  const narrow = useMediaQuery("(max-width: 599px)");
  const title = model.game ? t("world.worldsGameDisplayName", { gameDisplayName: model.game.displayName }) : t("common.worlds");

  if (model.unavailable) {
    return (
      <Page>
        <h1 className="visually-hidden">{t("common.worlds")}</h1>
        <Notices notices={model.notices} />
        <Panel><Empty title={t("world.noGamesShow")} /></Panel>
      </Page>
    );
  }

  return (
    <Page>
      <h1 className="visually-hidden">{t("common.worlds")}</h1>
      <Notices notices={model.notices} />
      <Panel className="t-host" name={t("world.host")}>
        <div aria-busy={loading || undefined} className="t-host-body">
          {!narrow && <GameIcon game={model.game} size="40x18" state={model.overview.state} />}
          {loading ? <HostSkeleton compact={narrow} /> : <HostState compact={narrow} overview={model.overview} />}
        </div>
      </Panel>
      <Panel
        className="t-worlds-list"
        flush
        name={narrow ? t("common.worlds") : title}
        verbs={<>
          {narrow
            ? <Overflow groups={[[...(model.createWorld ? [model.createWorld] : []), model.refresh]]} label={t("world.worldActions")} size="small" />
            : <>{model.createWorld && <Verb action={model.createWorld} tone="primary" />}<Verb action={model.refresh} /></>}
        </>}
      >
        <Table
          columns={worldColumns}
          empty={<Empty title={t("world.noWorldsGame")} />}
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
    <SkeletonGroup className="t-host-skeleton" label={t("world.readingHost")}>
      <Skeleton width="long" />
      <Skeleton width="medium" />
      {!compact && <div className="t-host-skeleton-facts">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} width={index % 2 === 0 ? "medium" : "short"} />)}
      </div>}
    </SkeletonGroup>
  );
}

export const worldColumns: readonly Col<WorldRow>[] = [
  { id: "status", label: t("common.status"), width: "1%", render: (row) => <Indicator kind={row.status.kind} label={row.status.label} /> },
  { id: "name", label: t("common.name"), width: "22%", render: (row) => <a className="t-row-link" href={row.href}>{row.world.displayName}</a> },
  { id: "release", label: t("world.presetRelease2"), compactBlock: true, width: "24%", render: (row) => <span className="t-stack"><strong>{row.presetName}</strong><small>{row.releaseSummary}</small></span> },
  {
    id: "wipe",
    label: t("common.wipe"),
    width: "20%",
    optional: true,
    render: (row) => row.wipe
      ? <strong>#{row.wipe.number}</strong>
      : <Ghost>{row.wipeAbsent}</Ghost>,
  },
  { id: "address", label: t("common.address"), render: (row) => row.address ? <Address connectivity={row.address.connectivity} copyLabel={t("world.copyAddressWorldDisplayName", { worldDisplayName: row.world.displayName })} network={row.address.network} size="small" value={row.address.value} /> : <Ghost>{row.addressAbsent}</Ghost> },
  { id: "verbs", label: t("common.actions"), verbs: true, corner: true, render: (row) => <Overflow groups={[row.actions]} label={t("world.moreActionsWorldDisplayName", { worldDisplayName: row.world.displayName })} size="small" /> },
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
        {overview.players !== null && <span>{rich("world.playersOnlineCount", { players: <strong>{t("common.playerCount", { count: overview.players })}</strong> })} · </span>}
        <span>{rich("world.observedAt", { time: <strong>{formatDateTime(overview.observedAt)}</strong> })}</span>
      </p>
    </div>
  );
  return (
    <div className="t-host-state">
      <span className="t-host-title"><State kind={overview.status.kind} label={overview.headline} size="large" />{!overview.fleet && <Help text={overview.reason.detail} />}</span>
      <p className="t-host-line">
        {overview.players !== null && <span>{rich("world.playersOnlineCount", { players: <strong>{t("common.playerCount", { count: overview.players })}</strong> })} · </span>}
        <span>{rich("world.observedAt", { time: <strong>{formatDateTime(overview.observedAt)}</strong> })}</span>
      </p>
      <dl className="t-facts">
        {overview.fleet ? <>
          <Fact label={t("world.fleetHosts")}>{t("world.fleetRunning", { count: overview.fleetHosts.running })}</Fact>
          <Fact label={t("world.provisioning")}>{t("world.fleetHostCount", { count: overview.fleetHosts.pending })}</Fact>
        </> : <>
          <Fact label={t("common.computeHost")}>{host ? <><State kind={host.status.kind} label={host.status.label} /><small>{host.name}</small></> : <Ghost>{t("world.noHostAvailable")}</Ghost>}</Fact>
          <Fact label={t("common.instanceType")}>{host?.instanceType ? <code>{host.instanceType}</code> : <Ghost>{t("world.notReported")}</Ghost>}</Fact>
          <Fact label={t("world.zone")}>{host?.zone ? <code>{host.zone}</code> : <Ghost>{t("world.notReported")}</Ghost>}</Fact>
          <Fact label={t("world.launched")}>{host?.launchedAt ? <Timestamp value={host.launchedAt} /> : <Ghost>{t("world.notRunning")}</Ghost>}</Fact>
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
