import type { ReactNode } from "react";

import { Column, DataTable } from "../../components/ui/DataTable";
import { Ellipsis } from "../../components/ui/Ellipsis";
import { Menu } from "../../components/ui/Menu";
import { Skeleton } from "../../components/ui/Skeleton";
import { Status } from "../../components/ui/Status";
import { Banner, Card, CopyButton, EmptyState, Ghost } from "../../components/ui/Surfaces";
import { Timestamp } from "../../components/ui/Timestamp";
import { Tooltip } from "../../components/ui/Tooltip";
import type { AddressFacts, Notice, SessionOverview, WorldRow, WorldsModel } from "../../core/models";
import { Icon } from "../../icons";
import { formatDateTime, plural } from "../../lib/format";
import { ActionButton, menuItems } from "./actions";

export const worldColumns: Column<WorldRow>[] = [
  { id: "status", label: "Status", width: "15%", render: (row) => <Status kind={row.status.kind} label={row.status.label} /> },
  {
    id: "name",
    label: "Name",
    // Shares are declared, because auto layout hands the width to whichever
    // cell wraps first: a date breaking into three lines was taking it from
    // the name, which then truncated to four characters.
    width: "24%",
    render: (row) => <a className="row-link" href={row.href}>{row.world.displayName}</a>,
  },
  { id: "release", label: "Preset and release", width: "20%", render: (row) => <span><strong>{row.presetName}</strong><small>{row.releaseSummary}</small></span> },
  {
    id: "wipe",
    label: "Wipe",
    width: "16%",
    render: (row) => row.wipe
      ? <span title="A wipe is one generation of this world. Starting a new one keeps every backup of the old one."><strong className="num">#{row.wipe.number}</strong><small className="nowrap">Opened {row.wipe.openedAt}</small></span>
      : <Ghost>{row.wipeAbsent}</Ghost>,
  },
  {
    id: "address",
    label: "Address",
    // An address is copied, not read character by character, so it gives up
    // width before the table has to scroll.
    truncate: true,
    width: "25%",
    render: (row) => row.address ? <ConnectionAddress address={row.address} copyLabel={`Copy the address of ${row.world.displayName}`} /> : <Ghost>{row.addressAbsent}</Ghost>,
  },
  { id: "actions", label: "Actions", actions: true, render: (row) => <Menu items={menuItems(row.actions)} label={`More actions for ${row.world.displayName}`} size="small" /> },
];

export function Worlds({ model }: Readonly<{ model: WorldsModel }>) {
  const loading = model.status === "loading";

  if (model.unavailable) {
    return (
      <div className="page">
        <h1 className="visually-hidden">Worlds</h1>
        <Notices notices={model.notices} />
        <Card flush><EmptyState description={model.unavailable.description} icon="public" title="No games to show" /></Card>
      </div>
    );
  }


  return (
    <div className="page">
      <h1 className="visually-hidden">Worlds</h1>
      <Notices notices={model.notices} />
      <Overview loading={loading} overview={model.overview} />
      <Card
        actions={<>
          <ActionButton action={model.refresh} variant="outlined" />
          {model.createWorld && <ActionButton action={model.createWorld} variant="filled" />}
        </>}
        flush
        title={model.game ? `Worlds of ${model.game.displayName}` : "Worlds"}
      >
        <DataTable
          columns={worldColumns}
          empty={<EmptyState description={model.emptyDescription} icon="public" title="No worlds in this game" />}
          label={model.game ? `Worlds of ${model.game.displayName}` : "Worlds"}
          loading={loading}
          loadingRows={3}
          rowKey={(row) => row.world.id}
          rows={model.rows}
        />
      </Card>
    </div>
  );
}

export function Notices({ notices }: Readonly<{ notices: readonly Notice[] }>) {
  return <>{notices.map((notice) => (
    <Banner actions={notice.action ? <ActionButton action={notice.action} variant="text" /> : undefined} description={notice.description} key={notice.id} title={notice.title} tone={notice.tone} />
  ))}</>;
}

function Overview({ overview, loading }: Readonly<{ overview: SessionOverview; loading: boolean }>) {
  const host = overview.host;
  return (
    <Card as="section" className="session-card-wrap" flush>
      <div aria-busy={loading} className="session-card">
        <div className="session-state">
          {loading ? <Skeleton height={28} width="60%" /> : <Status kind={overview.status.kind} label={overview.headline} size="large" />}
          <div className="pairs">
            {loading ? <><Skeleton width="70%" /><Skeleton width="50%" /></> : <>
              <span className={overview.reason.attention ? "session-reason session-reason-attention" : "session-reason"}>
                {overview.reason.text}
                {!overview.fleet && <Tooltip text={overview.reason.detail}><Icon name="help" size={14} /></Tooltip>}
              </span>
              {overview.players !== null && <span><strong>{plural(overview.players, "player")}</strong> online</span>}
              <span>Last observed <strong>{formatDateTime(overview.observedAt)}</strong></span>
            </>}
          </div>
        </div>
        <dl className="session-facts">
          {overview.fleet ? <>
            <Fact label="Fleet hosts" loading={loading}>{overview.fleetHosts.running} running</Fact>
            <Fact label="Provisioning" loading={loading}>{overview.fleetHosts.pending} hosts</Fact>
          </> : <>
            <Fact label="Compute host" loading={loading}>{host ? <Status kind={host.status.kind} label={`${host.name} · ${host.status.label.toLowerCase()}`} /> : <Ghost>No host available</Ghost>}</Fact>
            <Fact label="Instance type" loading={loading} mono>{host?.instanceType ?? <Ghost>Not reported</Ghost>}</Fact>
            <Fact label="Zone" loading={loading} mono>{host?.zone ?? <Ghost>Not reported</Ghost>}</Fact>
            <Fact label="Launched" loading={loading}>{host?.launchedAt ? <Timestamp value={host.launchedAt} /> : <Ghost>Not running</Ghost>}</Fact>
          </>}
        </dl>
      </div>
    </Card>
  );
}

function Fact({ label, children, loading, mono = false }: Readonly<{ label: string; children: ReactNode; loading: boolean; mono?: boolean }>) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{loading ? <Skeleton width="70%" /> : children}</dd>
    </div>
  );
}

// The network an address belongs to is a property of the address, so it rides
// in front of it as one icon instead of a caption under every row.
export function ConnectionAddress({ address, copyLabel }: Readonly<{ address: AddressFacts; copyLabel?: string }>) {
  return (
    <span className="copy-value">
      <Tooltip className="address-network" text={address.network}>
        <Icon name={address.connectivity === "zerotier" ? "dns" : "public"} size={16} />
        <span className="visually-hidden">{address.network}</span>
      </Tooltip>
      <Ellipsis mono tail={18} value={address.value} />
      {copyLabel && <CopyButton label={copyLabel} value={address.value} />}
    </span>
  );
}
