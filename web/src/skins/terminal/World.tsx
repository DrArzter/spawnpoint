import type { ReactNode } from "react";

import type { BackupEntry } from "../../api/contract";
import { Timestamp } from "../../components/ui/Timestamp";
import { action } from "../../core/actions";
import type { BackupsModel, Detail, DetailValue, ModRow, ModsModel, ReleaseRow, WorldModel } from "../../core/models";
import { wipeStatus } from "../../core/worlds";
import { Icon } from "../../icons";
import { formatBytes, formatTime, shortDigest } from "../../lib/format";
import { useMediaQuery } from "../../shell/hooks";
import { Address, Choice, Choices, Col, DetailRow, DetailsGroup, Empty, Ghost, Indicator, Notice, Overflow, Page, Panel, State, Table, Tabs, Verb, Verbs } from "./ui";
import { MetricsPanel } from "./Metrics";
import { ConsolePanel } from "./Rcon";
import { Notices } from "./Worlds";

// One world: its name and state on the first line, its verbs on the second
// with the one that matters first, the notices, then the sections behind tabs.
export function World({ model }: Readonly<{ model: WorldModel }>) {
  const { world, game } = model;
  const compact = useMediaQuery("(max-width: 839px)");
  const compactActions = [model.refresh, ...(model.invite ? [model.invite] : [])];

  return (
    <Page>
      <header className="t-page-head">
        <div className="t-page-title">
          <a className="t-crumb" href={model.worldsHref}><span aria-hidden="true">&lt;</span> Worlds</a>
          <h1>{world.displayName}</h1>
          <Indicator kind={model.availability.kind} label={model.availability.label} />
        </div>
        <Verbs className="t-page-verbs">
          <Verb action={model.session} tone="primary" tooltipWhenDisabled />
          {!compact && <Verb action={model.refresh} />}
          {!compact && model.invite && <Verb action={model.invite} />}
          {(compact || model.more.length > 0) && <Overflow groups={compact ? [compactActions, model.more] : [model.more]} label={`More actions for ${world.displayName}`} />}
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
          <Table columns={operationColumns} empty={<Empty title="No operation in progress" />} label="Running operations" rowKey={(row) => `${row.operation.type}-${row.operation.id}`} rows={model.operations} />
        </Panel>
      </>}
      {model.tab === "wipes" && <WipesTab rows={model.wipes} worldName={world.displayName} />}
      {model.tab === "backups" && <BackupsTab model={model.backups} worldName={world.displayName} />}
      {model.tab === "releases" && <ReleasesTab releases={model.releases} worldName={world.displayName} />}
      {model.tab === "console" && model.console && <ConsolePanel model={model.console} />}
      {model.tab === "metrics" && model.metrics && <MetricsPanel model={model.metrics} />}
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
    case "release": {
      const aligned = value.active !== null && value.active === value.desired;
      const label = aligned ? "Active and desired" : `Active ${value.active ?? "none"}; desired ${value.desired ?? "none"}`;
      return <span className="t-inline"><code>{value.desired ?? value.active ?? "none"}</code><Indicator kind={aligned ? "ok" : "pending"} label={label} /></span>;
    }
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
  { id: "status", label: "Status", width: "80px", render: () => <Indicator kind="progress" label="Running" /> },
];

function WipesTab({ rows, worldName }: Readonly<{ rows: WorldModel["wipes"]; worldName: string }>) {
  const columns: readonly Col<WorldModel["wipes"][number]>[] = [
    { id: "wipe", label: "Wipe", width: "100px", render: (row) => <strong>#{row.wipe.number}</strong> },
    { id: "status", label: "Status", width: "80px", render: (row) => <Indicator kind={row.wipe.state === "current" ? "ok" : "archived"} label={row.wipe.state === "current" ? "Current" : wipeStatus(row.wipe).label} /> },
    { id: "release", label: "Started on release", width: "160px", render: (row) => <code>{row.wipe.originRelease}</code> },
    { id: "opened", label: "Opened", render: (row) => <Timestamp value={row.wipe.createdAt} /> },
    { id: "closed", label: "Closed", render: (row) => (row.wipe.closedAt ? <Timestamp value={row.wipe.closedAt} /> : <Ghost>Open</Ghost>) },
    { id: "verbs", label: "Actions", verbs: true, corner: true, render: (row) => <Overflow groups={[[row.showBackups]]} label={`Actions for wipe ${row.wipe.number}`} size="small" /> },
  ];
  return (
    <Panel flush name="Wipes">
      <Table columns={columns} empty={<Empty title="No wipes yet" />} label={`Wipes of ${worldName}`} rowKey={(row) => row.wipe.id} rows={rows} />
    </Panel>
  );
}

function BackupsTab({ model, worldName }: Readonly<{ model: BackupsModel; worldName: string }>) {
  const columns: readonly Col<BackupEntry>[] = [
    { id: "archive", label: "Archive", width: "36%", render: (entry) => <code className="t-clip" title={entry.archiveName}>{entry.archiveName}</code> },
    { id: "wipe", label: "Wipe", width: "90px", render: (entry) => { const number = model.wipeNumber(entry.generationId); return number !== undefined ? <span>#{number}</span> : <Ghost>Legacy</Ghost>; } },
    { id: "stored", label: "Stored", width: "170px", render: (entry) => <Timestamp value={entry.storedAt} /> },
    { id: "size", label: "Size", width: "130px", align: "end", render: (entry) => formatBytes(entry.sizeBytes) },
    { id: "checksum", label: "SHA-256", secondary: true, width: "180px", render: (entry) => <Digest value={entry.checksum} /> },
    { id: "verbs", label: "Actions", verbs: true, corner: true, render: (entry) => <Overflow groups={[
      [copyValueAction(`backup.copy-archive.${entry.key}`, "Copy archive name", entry.archiveName), copyValueAction(`backup.copy-checksum.${entry.key}`, "Copy SHA-256", entry.checksum)],
      ...(model.download ? [[model.download(entry)]] : []),
      [model.restore(entry)],
    ]} label={`Actions for ${entry.archiveName}`} size="small" /> },
  ];

  if (!model.canRead) {
    return <Panel flush name="Backups"><Empty description="Ask an owner for the backup.read permission to list verified backups." title="Your role cannot read backups" /></Panel>;
  }
  const inventory = model.inventory;
  return (
    <Panel flush name="Backups">
      {model.wipes.length > 0 && (
        <div className="t-filter-row">
          <Choices label="Filter backups by wipe">
            <Choice onClick={() => model.setFilter(null)} pressed={model.filter === null}>All wipes</Choice>
            {[...model.wipes].reverse().map((wipe) => <Choice key={wipe.id} onClick={() => model.setFilter(wipe.id)} pressed={model.filter === wipe.id}>Wipe #{wipe.number}</Choice>)}
          </Choices>
        </div>
      )}
      {inventory.status === "error" && inventory.kind === "unavailable" && <Empty title="The backup inventory is not connected yet" />}
      {inventory.status === "error" && inventory.kind !== "unavailable" && <div className="t-inset"><Notice description={inventory.error} title="The inventory is unavailable" tone="error" verbs={<Verb action={inventory.retry} size="small" />} /></div>}
      {inventory.status !== "error" && <Table
        columns={columns}
        empty={<Empty title="No verified backups" />}
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

// A SHA-256: its start in a narrow column, all of it where there is room.
function Digest({ value }: Readonly<{ value: string }>) {
  return <code className="t-checksum" title={value}><span className="t-checksum-short">{shortDigest(value)}</span><span className="t-checksum-full">{value}</span></code>;
}

function ReleasesTab({ releases, worldName }: Readonly<{ releases: WorldModel["releases"]; worldName: string }>) {
  const columns: readonly Col<ReleaseRow>[] = [
    { id: "release", label: "Release", render: (row) => <span className="t-release-line">
      {row.sourceHref ? <a className="t-source" href={row.sourceHref} rel="noreferrer" target="_blank" title="Open preset repository"><code>{row.name}</code><Icon name="open_in_new" size={14} /></a> : <code>{row.name}</code>}
      <Indicator kind={row.status === "Desired" ? "pending" : "ok"} label={row.status === "Desired" ? "Desired, not yet active" : row.status} />
      {row.download && <Verb action={row.download} size="small" />}
    </span> },
  ];
  return <>
    <Panel flush>
      <Table columns={columns} empty={<Empty title="No release" />} label={`Release pointer of ${worldName}`} rowKey={(row) => row.name} rows={releases.rows} />
    </Panel>
    {releases.mods && <ModsPanel mods={releases.mods} worldName={worldName} />}
  </>;
}

// The server mods of the release the world starts with (ADR-0065).
function ModsPanel({ mods, worldName }: Readonly<{ mods: ModsModel; worldName: string }>) {
  const columns: readonly Col<ModRow>[] = [
    { id: "file", label: "File", render: (row) => <code className="t-clip" title={row.file}>{row.file}</code> },
    { id: "size", label: "Size", width: "110px", align: "end", render: (row) => formatBytes(row.bytes) },
    { id: "checksum", label: "SHA-256", secondary: true, width: "180px", render: (row) => <Digest value={row.sha256} /> },
    { id: "verbs", label: "Actions", verbs: true, corner: true, render: (row) => <Verb action={row.download} size="small" /> },
  ];
  const files = mods.files;
  return (
    <Panel flush name={`Server mods · release ${mods.release}`}>
      {files.status === "error"
        ? <div className="t-inset"><Notice description={files.error} title="The mods are unavailable" tone="error" verbs={<Verb action={files.retry} size="small" />} /></div>
        : <Table
          columns={columns}
          empty={<Empty title="This release has no server mods" />}
          label={`Server mods of ${worldName}, release ${mods.release}`}
          loading={files.status === "loading"}
          rowKey={(row) => row.sha256}
          rows={files.status === "ready" ? files.value : []}
        />}
    </Panel>
  );
}

function copyValueAction(id: string, label: string, value: string) {
  return action(id, label, () => { void navigator.clipboard?.writeText(value); }, { icon: "content_copy" });
}
