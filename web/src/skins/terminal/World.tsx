import type { ReactNode } from "react";

import type { BackupEntry } from "../../api/contract";
import { Timestamp } from "../../components/ui/Timestamp";
import type { BackupsModel, Detail, DetailValue, ReleaseRow, WorldModel } from "../../core/models";
import { wipeStatus } from "../../core/worlds";
import { Icon } from "../../icons";
import { formatBytes, formatTime, shortDigest } from "../../lib/format";
import { Address, Choice, Choices, Col, Copy, DetailRow, DetailsGroup, Empty, Ghost, Notice, Overflow, Page, Panel, State, Table, Tabs, Verb, Verbs } from "./ui";
import { Notices } from "./Worlds";

// One world: its name and state on the first line, its verbs on the second
// with the one that matters first, the notices, then the sections behind tabs.
export function World({ model }: Readonly<{ model: WorldModel }>) {
  const { world, game } = model;

  return (
    <Page>
      <header className="t-page-head">
        <div className="t-page-title">
          <a className="t-crumb" href={model.worldsHref}><span aria-hidden="true">&lt;</span> Worlds</a>
          <h1>{world.displayName}</h1>
          <State kind={model.availability.kind} label={model.availability.label} />
        </div>
        <Verbs className="t-page-verbs">
          <Verb action={model.session} tone="primary" />
          <Verb action={model.refresh} />
          {model.invite && <Verb action={model.invite} />}
          {model.more.length > 0 && <Overflow groups={[model.more]} label={`More actions for ${world.displayName}`} />}
        </Verbs>
      </header>
      <Notices notices={model.notices} />

      <Tabs label="World sections" onChange={model.setTab} options={model.tabs} value={model.tab} />
      {model.tab === "details" && <>
        <Panel>
          <div className="t-details-columns">
            <DetailsGroup items={model.sessionDetails.map(detailRow)} level={2} title="Session" />
            <DetailsGroup items={model.worldDetails.map(detailRow)} level={2} title="World" />
          </div>
        </Panel>
        <Panel flush name="Operations">
          <Table columns={operationColumns} empty={<Empty description="Completed executions will be listed after the operations API exposes history. Spawnpoint shows only what it observes." title="No operation in progress" />} label="Running operations" rowKey={(row) => `${row.operation.type}-${row.operation.id}`} rows={model.operations} />
        </Panel>
      </>}
      {model.tab === "wipes" && <WipesTab rows={model.wipes} worldName={world.displayName} />}
      {model.tab === "backups" && <BackupsTab model={model.backups} worldName={world.displayName} />}
      {model.tab === "releases" && <ReleasesTab rows={model.releases.rows} state={model.releases.state} worldName={world.displayName} />}
      <span className="visually-hidden">{game.displayName}</span>
    </Page>
  );
}

function detailValue(value: DetailValue): ReactNode {
  switch (value.type) {
    case "text": return value.mono ? <code>{value.text}</code> : <span>{value.text}</span>;
    case "absent": return <Ghost>{value.text}</Ghost>;
    case "status": return <State kind={value.status.kind} label={value.status.label} />;
    case "time": return <Timestamp value={value.at} />;
    case "number": return <strong>{value.value}</strong>;
    case "release": return <span className="t-pair"><span>Active <strong>{value.active ?? "none"}</strong></span><span aria-hidden="true" className="t-pair-arrow">&gt;</span><span>Desired <strong>{value.desired ?? "none"}</strong></span></span>;
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
  if (unverified > 0) parts.push(`${unverified} ${unverified === 1 ? "object" : "objects"} could not be verified and ${unverified === 1 ? "is" : "are"} not shown.`);
  if (truncated) parts.push("Older backups exist beyond the newest shown.");
  return parts.join(" ");
}

const operationColumns: readonly Col<WorldModel["operations"][number]>[] = [
  { id: "operation", label: "Operation", render: (row) => <strong>{row.label}</strong> },
  { id: "execution", label: "Execution", render: (row) => <code className="t-clip">{row.operation.id}</code> },
  { id: "started", label: "Started", width: "140px", render: (row) => <span>{formatTime(row.operation.startedAt)}</span> },
  { id: "status", label: "Status", width: "140px", render: () => <State kind="progress" label="Running" /> },
];

function WipesTab({ rows, worldName }: Readonly<{ rows: WorldModel["wipes"]; worldName: string }>) {
  const columns: readonly Col<WorldModel["wipes"][number]>[] = [
    { id: "wipe", label: "Wipe", width: "100px", render: (row) => <strong>#{row.wipe.number}</strong> },
    { id: "status", label: "Status", width: "140px", render: (row) => (row.wipe.state === "current" ? <State kind="ok" label="Current" /> : <State kind="archived" label={wipeStatus(row.wipe).label} />) },
    { id: "release", label: "Started on release", width: "160px", render: (row) => <code>{row.wipe.originRelease}</code> },
    { id: "opened", label: "Opened", render: (row) => <Timestamp value={row.wipe.createdAt} /> },
    { id: "closed", label: "Closed", render: (row) => (row.wipe.closedAt ? <Timestamp value={row.wipe.closedAt} /> : <Ghost>Open</Ghost>) },
    { id: "verbs", label: "Actions", verbs: true, render: (row) => <Verb action={row.showBackups} size="small" /> },
  ];
  return (
    <Panel flush name="Wipes">
      <Table columns={columns} empty={<Empty description="The first start opens wipe #1." title="No wipes yet" />} label={`Wipes of ${worldName}`} rowKey={(row) => row.wipe.id} rows={rows} />
    </Panel>
  );
}

function BackupsTab({ model, worldName }: Readonly<{ model: BackupsModel; worldName: string }>) {
  const columns: readonly Col<BackupEntry>[] = [
    { id: "archive", label: "Archive", width: "40%", render: (entry) => <span className="t-inline"><code className="t-clip" title={entry.archiveName}>{entry.archiveName}</code><Copy label={`Copy the archive name ${entry.archiveName}`} value={entry.archiveName} /></span> },
    { id: "wipe", label: "Wipe", width: "90px", render: (entry) => { const number = model.wipeNumber(entry.generationId); return number !== undefined ? <span>#{number}</span> : <Ghost>Legacy</Ghost>; } },
    { id: "stored", label: "Stored", render: (entry) => <Timestamp value={entry.storedAt} /> },
    { id: "size", label: "Size", width: "110px", align: "end", render: (entry) => formatBytes(entry.sizeBytes) },
    { id: "checksum", label: "SHA-256", secondary: true, width: "180px", render: (entry) => <span className="t-inline"><code title={entry.checksum}>{shortDigest(entry.checksum)}</code><Copy label="Copy the full checksum" value={entry.checksum} /></span> },
    { id: "verbs", label: "Actions", verbs: true, render: (entry) => <Verb action={model.restore(entry)} size="small" /> },
  ];

  if (!model.canRead) {
    return <Panel flush name="Backups"><Empty description="Ask an owner for the backup.read permission to list verified backups." title="Your role cannot read backups" /></Panel>;
  }
  const inventory = model.inventory;
  return (
    <Panel description="Restoring one opens a new wipe. Nothing here is overwritten." flush name="Backups">
      {model.wipes.length > 0 && (
        <div className="t-filter-row">
          <Choices label="Filter backups by wipe">
            <Choice onClick={() => model.setFilter(null)} pressed={model.filter === null}>All wipes</Choice>
            {[...model.wipes].reverse().map((wipe) => <Choice key={wipe.id} onClick={() => model.setFilter(wipe.id)} pressed={model.filter === wipe.id}>Wipe #{wipe.number}</Choice>)}
          </Choices>
        </div>
      )}
      {inventory.status === "error" && inventory.kind === "unavailable" && <Empty description="Verified archives appear here once the backup inventory is reachable." title="The backup inventory is not connected yet" />}
      {inventory.status === "error" && inventory.kind !== "unavailable" && <div className="t-inset"><Notice description={inventory.error} title="The inventory is unavailable" tone="error" verbs={<Verb action={inventory.retry} size="small" />} /></div>}
      {inventory.status !== "error" && <Table
        columns={columns}
        empty={<Empty description={model.filter ? "This wipe has no verified backups yet." : "Backups are taken at every safe stop and before every wipe."} title="No verified backups" />}
        label={`Verified backups of ${worldName}`}
        loading={inventory.status === "loading"}
        rowKey={(entry) => entry.key}
        rows={inventory.status === "ready" ? inventory.value.entries : []}
      />}
      {inventory.status === "ready" && (inventory.value.unverified > 0 || inventory.value.truncated) && (
        <div className="t-inset"><Notice description={partialInventoryDescription(inventory.value.unverified, inventory.value.truncated)} title="Inventory is partial" tone="warning" /></div>
      )}
    </Panel>
  );
}

function ReleasesTab({ rows, state, worldName }: Readonly<{ rows: readonly ReleaseRow[]; state: WorldModel["releases"]["state"]; worldName: string }>) {
  const columns: readonly Col<ReleaseRow>[] = [
    { id: "release", label: "Release", width: "140px", render: (row) => <code>{row.name}</code> },
    { id: "status", label: "Pointer status", render: (row) => (row.status === "Desired" ? <State kind="pending" label="Desired, not yet active" /> : <State kind="ok" label={row.status} />) },
    { id: "pack", label: "Client pack", verbs: true, render: (row) => (row.download ? <Verb action={row.download} size="small" /> : <Ghost>{row.downloadable ? "Needs connection.read" : "Available once active"}</Ghost>) },
  ];
  return (
    <Panel description="Pack links are presigned for an hour." flush name="Release pointer">
      <Table columns={columns} empty={<Empty description={state === "unconfigured" ? "This world has no release pointer yet." : "Release data is unavailable."} title="No release" />} label={`Release pointer of ${worldName}`} rowKey={(row) => row.name} rows={rows} />
    </Panel>
  );
}
