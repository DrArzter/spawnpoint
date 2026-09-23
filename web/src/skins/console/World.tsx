import type { ReactNode } from "react";

import type { BackupEntry } from "../../api/contract";
import { Chip, ChoiceChip } from "../../components/ui/Chip";
import { Column, DataTable } from "../../components/ui/DataTable";
import { Ellipsis } from "../../components/ui/Ellipsis";
import { Menu, type MenuItem } from "../../components/ui/Menu";
import { Status } from "../../components/ui/Status";
import { Banner, Card, CopyButton, DetailItem, DetailsGroup, EmptyState, Ghost, NotConnected, PageHeader } from "../../components/ui/Surfaces";
import { Tabs } from "../../components/ui/Tabs";
import { Timestamp } from "../../components/ui/Timestamp";
import type { Action } from "../../core/actions";
import type { BackupsModel, Detail, DetailValue, ReleaseRow, WorldModel } from "../../core/models";
import { wipeStatus } from "../../core/worlds";
import { Icon } from "../../icons";
import { formatBytes, formatTime, shortDigest } from "../../lib/format";
import type { Operation, Wipe } from "../../model";
import { useMediaQuery } from "../../shell/hooks";
import { ActionButton, menuGroups, menuItems } from "./actions";
import { ConnectionAddress, Notices } from "./Worlds";

export function World({ model }: Readonly<{ model: WorldModel }>) {
  const { world, game } = model;
  // A phone has room for one decision. Refresh and Invite are worth reaching,
  // not worth three wrapped rows above the page, so they move into the overflow.
  const narrow = useMediaQuery("(max-width: 599px)");
  const secondary: Action[] = [model.refresh, ...(model.invite ? [model.invite] : [])];
  const overflow: (MenuItem | "separator")[] = narrow ? menuGroups(secondary, model.more) : menuItems(model.more);

  return (
    <div className="page">
      <PageHeader
        actions={<>
          {!narrow && <ActionButton action={model.refresh} variant="outlined" />}
          {!narrow && model.invite && <ActionButton action={model.invite} variant="outlined" />}
          <ActionButton action={model.session} tooltipWhenDisabled variant="filled" />
        </>}
        breadcrumb={[{ label: "Worlds", href: model.worldsHref }]}
        overflow={overflow.length > 0 ? <Menu align="end" items={overflow} label={`More actions for ${world.displayName}`} /> : undefined}
        status={<Status kind={model.availability.kind} label={model.availability.label} />}
        title={world.displayName}
      />
      <Notices notices={model.notices} />

      <div className="world-tabs">
        <Tabs label="World sections" onChange={model.setTab} options={model.tabs} value={model.tab} />
        {model.tab === "details" && <>
          <Card><div className="details-columns"><DetailsGroup items={model.sessionDetails.map(detailItem)} level={2} title="Session" /><DetailsGroup items={model.worldDetails.map(detailItem)} level={2} title="World" /></div></Card>
          <Card flush title="Operations">
            <DataTable columns={operationColumns} empty={<EmptyState description="Completed executions will be listed after the operations API exposes history. Spawnpoint shows only what it observes." icon="sync" title="No operation in progress" />} label="Running operations" rowKey={(row) => `${row.operation.type}-${row.operation.id}`} rows={model.operations} />
          </Card>
        </>}
        {model.tab === "wipes" && <WipesTab rows={model.wipes} worldName={world.displayName} />}
        {model.tab === "backups" && <BackupsTab model={model.backups} worldName={world.displayName} />}
        {model.tab === "releases" && <ReleasesTab rows={model.releases.rows} state={model.releases.state} worldName={world.displayName} />}
      </div>
      <span className="visually-hidden">{game.displayName}</span>
    </div>
  );
}

function detailValue(value: DetailValue): ReactNode {
  switch (value.type) {
    case "text": return value.mono ? <code>{value.text}</code> : <span>{value.text}</span>;
    case "absent": return <Ghost>{value.text}</Ghost>;
    case "status": return <Status kind={value.status.kind} label={value.status.label} />;
    case "time": return <Timestamp value={value.at} />;
    case "number": return <strong className="num">{value.value}</strong>;
    case "release": return <span className="pair"><span>Active <strong>{value.active ?? "none"}</strong></span><Icon name="chevron_right" size={16} /><span>Desired <strong>{value.desired ?? "none"}</strong></span></span>;
    default: return <ConnectionAddress address={value.address} />;
  }
}

function detailItem(detail: Detail): DetailItem {
  const hint = detail.hintTime !== undefined
    ? <>{detail.hint} <Timestamp value={detail.hintTime} /></>
    : detail.hint ? <span className={detail.hintAttention ? "session-reason-attention" : undefined}>{detail.hint}</span> : undefined;
  return { label: detail.label, value: detailValue(detail.value), hint, explain: detail.explain, copy: detail.copy };
}

const operationColumns: Column<WorldModel["operations"][number]>[] = [
  { id: "operation", label: "Operation", render: (row) => <strong>{row.label}</strong> },
  { id: "execution", label: "Execution", truncate: true, render: (row) => <Ellipsis mono tail={12} value={row.operation.id} /> },
  { id: "started", label: "Started", width: "140px", render: (row) => <span className="num">{formatTime(row.operation.startedAt)}</span> },
  { id: "status", label: "Status", width: "140px", render: () => <Status kind="progress" label="Running" /> },
];

function WipesTab({ rows, worldName }: Readonly<{ rows: WorldModel["wipes"]; worldName: string }>) {
  const columns: Column<WorldModel["wipes"][number]>[] = [
    { id: "wipe", label: "Wipe", width: "120px", render: (row) => <strong className="num">#{row.wipe.number}</strong> },
    { id: "status", label: "Status", width: "140px", render: (row) => (row.wipe.state === "current" ? <Chip tone="primary">Current</Chip> : <Chip tone="tonal">{wipeStatus(row.wipe).label}</Chip>) },
    { id: "release", label: "Started on release", width: "140px", render: (row) => <code>{row.wipe.originRelease}</code> },
    { id: "opened", label: "Opened", render: (row) => <Timestamp value={row.wipe.createdAt} /> },
    { id: "closed", label: "Closed", render: (row) => (row.wipe.closedAt ? <Timestamp value={row.wipe.closedAt} /> : <Ghost>Open</Ghost>) },
    { id: "actions", label: "Actions", actions: true, render: (row) => <ActionButton action={row.showBackups} size="small" variant="text" /> },
  ];
  return (
    <Card flush title="Wipes">
      <DataTable columns={columns} empty={<EmptyState description="The first start opens wipe #1." icon="history" title="No wipes yet" />} label={`Wipes of ${worldName}`} rowKey={(row: { wipe: Wipe }) => row.wipe.id} rows={rows} />
    </Card>
  );
}

function BackupsTab({ model, worldName }: Readonly<{ model: BackupsModel; worldName: string }>) {
  const columns: Column<BackupEntry>[] = [
    // The timestamp is the only part that tells two archives of one world apart,
    // so it is the part that survives a narrow column.
    { id: "archive", label: "Archive", truncate: true, width: "45%", render: (entry) => <span className="copy-value"><Ellipsis mono tail={22} value={entry.archiveName} /><CopyButton label={`Copy the archive name ${entry.archiveName}`} value={entry.archiveName} /></span> },
    { id: "wipe", label: "Wipe", width: "100px", render: (entry) => { const number = model.wipeNumber(entry.generationId); return number !== undefined ? <span className="num">#{number}</span> : <Ghost>Legacy</Ghost>; } },
    { id: "stored", label: "Stored", render: (entry) => <Timestamp value={entry.storedAt} /> },
    { id: "size", label: "Size", width: "110px", align: "num", render: (entry) => formatBytes(entry.sizeBytes) },
    { id: "checksum", label: "SHA-256", secondary: true, width: "210px", render: (entry) => <span className="copy-value"><code title={entry.checksum}>{shortDigest(entry.checksum)}</code><CopyButton label="Copy the full checksum" value={entry.checksum} /></span> },
    { id: "actions", label: "Actions", actions: true, render: (entry) => <ActionButton action={model.restore(entry)} size="small" variant="text" /> },
  ];

  if (!model.canRead) {
    return <Card flush title="Backups"><EmptyState description="Ask an owner for the backup.read permission to list verified backups." icon="lock" title="Your role cannot read backups" /></Card>;
  }
  const inventory = model.inventory;
  return (
    <Card description="Restoring one opens a new wipe. Nothing here is overwritten." flush title="Backups">
      {model.wipes.length > 0 && (
        <div className="filter-bar">
          <Icon name="filter_list" size={20} />
          <div aria-label="Filter backups by wipe" className="chip-row" role="group">
            <ChoiceChip onClick={() => model.setFilter(null)} pressed={model.filter === null}>All wipes</ChoiceChip>
            {[...model.wipes].reverse().map((wipe) => <ChoiceChip key={wipe.id} onClick={() => model.setFilter(wipe.id)} pressed={model.filter === wipe.id}>Wipe #{wipe.number}</ChoiceChip>)}
          </div>
        </div>
      )}
      {inventory.status === "error" && inventory.kind === "unavailable" && <NotConnected description="Verified archives appear here once the backup inventory is reachable." title="The backup inventory is not connected yet" />}
      {inventory.status === "error" && inventory.kind !== "unavailable" && <div style={{ padding: 16 }}><Banner actions={<ActionButton action={inventory.retry} variant="text" />} description={inventory.error} title="The inventory is unavailable" tone="error" /></div>}
      {inventory.status !== "error" && <DataTable
        columns={columns}
        empty={<EmptyState description={model.filter ? "This wipe has no verified backups yet." : "Backups are taken at every safe stop and before every wipe."} icon="backup" title="No verified backups" />}
        label={`Verified backups of ${worldName}`}
        loading={inventory.status === "loading"}
        rowKey={(entry) => entry.key}
        rows={inventory.status === "ready" ? inventory.value.entries : []}
      />}
      {inventory.status === "ready" && (inventory.value.unverified > 0 || inventory.value.truncated) && (
        <div style={{ padding: "0 16px 16px" }}>
          <Banner
            description={`${inventory.value.unverified > 0 ? `${inventory.value.unverified} object${inventory.value.unverified === 1 ? "" : "s"} could not be verified and ${inventory.value.unverified === 1 ? "is" : "are"} not shown. ` : ""}${inventory.value.truncated ? "Older backups exist beyond the newest shown." : ""}`}
            title="Inventory is partial"
            tone="warning"
          />
        </div>
      )}
    </Card>
  );
}

function ReleasesTab({ rows, state, worldName }: Readonly<{ rows: readonly ReleaseRow[]; state: WorldModel["releases"]["state"]; worldName: string }>) {
  const columns: Column<ReleaseRow>[] = [
    { id: "release", label: "Release", width: "140px", render: (row) => <code>{row.name}</code> },
    { id: "status", label: "Pointer status", render: (row) => (row.status === "Desired" ? <Status kind="pending" label="Desired, not yet active" /> : <Status kind="ok" label={row.status} />) },
    { id: "pack", label: "Client pack", actions: true, render: (row) => (row.download ? <ActionButton action={row.download} size="small" variant="text" /> : <Ghost>{row.downloadable ? "Needs connection.read" : "Available once active"}</Ghost>) },
  ];
  return (
    <Card description="Pack links are presigned for an hour." flush title="Release pointer">
      <DataTable columns={columns} empty={<EmptyState description={state === "unconfigured" ? "This world has no release pointer yet." : "Release data is unavailable."} icon="inventory" title="No release" />} label={`Release pointer of ${worldName}`} rowKey={(row) => row.name} rows={rows} />
    </Card>
  );
}

export type { Operation };
