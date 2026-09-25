import type { ReactNode } from "react";

import { DataTable } from "../../components/ui/DataTable";
import { Skeleton } from "../../components/ui/Skeleton";
import { Status } from "../../components/ui/Status";
import { Card, EmptyState, Ghost } from "../../components/ui/Surfaces";
import { Timestamp } from "../../components/ui/Timestamp";
import { Tooltip } from "../../components/ui/Tooltip";
import type { SessionOverview, WorldsModel } from "../../core/models";
import { Icon } from "../../icons";
import { formatDateTime, plural } from "../../lib/format";
import { useMediaQuery } from "../../shell/hooks";
import { ActionButton } from "../console/actions";
import { Notices, Worlds as ConsoleWorlds, worldColumns } from "../console/Worlds";
import { GameIcon } from "./GameIcon";

// The first screen of the terminal: the host as the game's icon drawn in
// glyphs with its state beside it, then every world of the scoped game as a row.
export function Worlds({ model }: Readonly<{ model: WorldsModel }>) {
  const loading = model.status === "loading";
  const narrow = useMediaQuery("(max-width: 599px)");
  if (model.unavailable) return <ConsoleWorlds model={model} />;
  const title = model.game ? `Worlds of ${model.game.displayName}` : "Worlds";
  return (
    <div className="page">
      <h1 className="visually-hidden">Worlds</h1>
      <Notices notices={model.notices} />
      <section aria-labelledby="thost-title" className="card thost">
        <header className="card-header"><div><h2 id="thost-title">Host</h2></div></header>
        <div aria-busy={loading} className="card-body thost-body">
          <GameIcon game={model.game} size={narrow ? "24x11" : "40x18"} state={model.overview.state} />
          <HostState loading={loading} overview={model.overview} />
        </div>
      </section>
      <Card
        actions={<>
          <ActionButton action={model.refresh} variant="outlined" />
          {model.createWorld && <ActionButton action={model.createWorld} variant="filled" />}
        </>}
        flush
        title={title}
      >
        <DataTable
          columns={worldColumns}
          empty={<EmptyState description={model.emptyDescription} icon="public" title="No worlds in this game" />}
          label={title}
          loading={loading}
          loadingRows={3}
          rowKey={(row) => row.world.id}
          rows={model.rows}
        />
      </Card>
    </div>
  );
}

function HostState({ overview, loading }: Readonly<{ overview: SessionOverview; loading: boolean }>) {
  const host = overview.host;
  if (loading) {
    return (
      <div className="thost-state">
        <Skeleton height={28} width="60%" />
        <Skeleton width="70%" />
        <Skeleton width="50%" />
      </div>
    );
  }
  return (
    <div className="thost-state">
      <Status kind={overview.status.kind} label={overview.headline} size="large" />
      <p className={overview.reason.attention ? "thost-line session-reason-attention" : "thost-line"}>
        {overview.reason.text}
        {!overview.fleet && <Tooltip text={overview.reason.detail}><Icon name="help" size={14} /></Tooltip>}
      </p>
      <p className="thost-line">
        {overview.players !== null && <span><strong>{plural(overview.players, "player")}</strong> online · </span>}
        <span>observed <strong>{formatDateTime(overview.observedAt)}</strong></span>
      </p>
      <dl className="session-facts thost-facts">
        {overview.fleet ? <>
          <Fact label="Fleet hosts">{overview.fleetHosts.running} running</Fact>
          <Fact label="Provisioning">{overview.fleetHosts.pending} hosts</Fact>
        </> : <>
          <Fact label="Compute host">{host ? <><Status kind={host.status.kind} label={host.status.label} /><small>{host.name}</small></> : <Ghost>No host available</Ghost>}</Fact>
          <Fact label="Instance type" mono>{host?.instanceType ?? <Ghost>Not reported</Ghost>}</Fact>
          <Fact label="Zone" mono>{host?.zone ?? <Ghost>Not reported</Ghost>}</Fact>
          <Fact label="Launched">{host?.launchedAt ? <Timestamp value={host.launchedAt} /> : <Ghost>Not running</Ghost>}</Fact>
        </>}
      </dl>
    </div>
  );
}

function Fact({ label, children, mono = false }: Readonly<{ label: string; children: ReactNode; mono?: boolean }>) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{children}</dd>
    </div>
  );
}
