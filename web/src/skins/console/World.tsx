import type { ReactNode } from "react";

import type { BackupEntry } from "../../api/contract";
import { Chip, ChoiceChip } from "../../components/ui/Chip";
import { Column, DataTable } from "../../components/ui/DataTable";
import { Ellipsis } from "../../components/ui/Ellipsis";
import { Menu, type MenuItem } from "../../components/ui/Menu";
import { Status } from "../../components/ui/Status";
import { Banner, Card, DetailItem, DetailsGroup, EmptyState, Ghost, NotConnected, PageHeader } from "../../components/ui/Surfaces";
import { Tabs } from "../../components/ui/Tabs";
import { Timestamp } from "../../components/ui/Timestamp";
import { Tooltip } from "../../components/ui/Tooltip";
import { action, type Action } from "../../core/actions";
import type { BackupsModel, Detail, DetailValue, ReleaseRow, WorldModel } from "../../core/models";
import { wipeStatus } from "../../core/worlds";
import { Icon } from "../../icons";
import { formatBytes, formatTime, shortDigest } from "../../lib/format";
import type { Wipe } from "../../model";
import { useMediaQuery } from "../../shell/hooks";
import { ActionButton, menuGroups, menuItems } from "./actions";
import { MetricsPanel } from "./Metrics";
import { ConsolePanel } from "./Rcon";
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
            <DataTable columns={operationColumns} empty={<EmptyState icon="sync" title="No operation in progress" />} label="Running operations" rowKey={(row) => `${row.operation.type}-${row.operation.id}`} rows={model.operations} />
          </Card>
        </>}
        {model.tab === "wipes" && <WipesTab rows={model.wipes} worldName={world.displayName} />}
        {model.tab === "backups" && <BackupsTab model={model.backups} worldName={world.displayName} />}
        {model.tab === "releases" && <ReleasesTab rows={model.releases.rows} worldName={world.displayName} />}
        {model.tab === "console" && model.console && <ConsolePanel model={model.console} />}
        {model.tab === "metrics" && model.metrics && <MetricsPanel model={model.metrics} />}
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
    case "release": {
      const aligned = value.active !== null && value.active === value.desired;
      const label = aligned ? "Active and desired" : `Active ${value.active ?? "none"}; desired ${value.desired ?? "none"}`;
      return <span className="release-world"><code>{value.desired ?? value.active ?? "none"}</code><Tooltip text={label}><Icon className={aligned ? "release-state-active" : "release-state-pending"} name={aligned ? "verified" : "schedule"} size={18} /><span className="visually-hidden">{label}</span></Tooltip></span>;
    }
    case "preset": return <>
      <span>{value.name}</span>
      {value.source && (
        <a className="preset-source" href={value.source.href} rel="noreferrer" target="_blank" title={value.source.commit}>
          <code>{value.source.short}</code>
          <Icon name="open_in_new" size={14} />
        </a>
      )}
    </>;
    default: return <ConnectionAddress address={value.address} />;
  }
}

function detailHint(detail: Detail): ReactNode {
  if (detail.hintTime !== undefined) return <>{detail.hint} <Timestamp value={detail.hintTime} /></>;
  if (!detail.hint) return undefined;
  return <span className={detail.hintAttention ? "session-reason-attention" : undefined}>{detail.hint}</span>;
}

function detailItem(detail: Detail): DetailItem {
  return { label: detail.label, value: detailValue(detail.value), hint: detailHint(detail), explain: detail.explain, copy: detail.copy };
}

// What the inventory could not show, in one sentence.
function partialInventoryDescription(unverified: number, truncated: boolean): string {
  const parts: string[] = [];
  if (unverified > 0) parts.push(`${unverified} ${unverified === 1 ? "object" : "objects"} could not be verified and ${unverified === 1 ? "is" : "are"} not shown.`);
  if (truncated) parts.push("Older backups exist beyond the newest shown.");
  return parts.join(" ");
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
    { id: "actions", label: "Actions", actions: true, render: (row) => <Menu items={menuItems([row.showBackups])} label={`Actions for wipe ${row.wipe.number}`} size="small" /> },
  ];
  return (
    <Card flush title="Wipes">
      <DataTable columns={columns} empty={<EmptyState icon="history" title="No wipes yet" />} label={`Wipes of ${worldName}`} rowKey={(row: { wipe: Wipe }) => row.wipe.id} rows={rows} />
    </Card>
  );
}

function BackupsTab({ model, worldName }: Readonly<{ model: BackupsModel; worldName: string }>) {
  const columns: Column<BackupEntry>[] = [
    // The timestamp is the only part that tells two archives of one world apart,
    // so it is the part that survives a narrow column.
    { id: "archive", label: "Archive", truncate: true, width: "45%", render: (entry) => <Ellipsis mono tail={22} value={entry.archiveName} /> },
    { id: "wipe", label: "Wipe", width: "100px", render: (entry) => { const number = model.wipeNumber(entry.generationId); return number !== undefined ? <span className="num">#{number}</span> : <Ghost>Legacy</Ghost>; } },
    { id: "stored", label: "Stored", render: (entry) => <Timestamp value={entry.storedAt} /> },
    { id: "size", label: "Size", width: "110px", align: "num", render: (entry) => formatBytes(entry.sizeBytes) },
    { id: "checksum", label: "SHA-256", secondary: true, width: "210px", render: (entry) => <code title={entry.checksum}>{shortDigest(entry.checksum)}</code> },
    { id: "actions", label: "Actions", actions: true, render: (entry) => <Menu items={menuItems([copyValueAction(`backup.copy-archive.${entry.key}`, "Copy archive name", entry.archiveName), copyValueAction(`backup.copy-checksum.${entry.key}`, "Copy SHA-256", entry.checksum), model.restore(entry)])} label={`Actions for ${entry.archiveName}`} size="small" /> },
  ];

  if (!model.canRead) {
    return <Card flush title="Backups"><EmptyState description="Ask an owner for the backup.read permission to list verified backups." icon="lock" title="Your role cannot read backups" /></Card>;
  }
  const inventory = model.inventory;
  return (
    <Card flush title="Backups">
      {model.wipes.length > 0 && (
        <div className="filter-bar">
          <Icon name="filter_list" size={20} />
          <fieldset className="chip-row fieldset-plain">
            <legend className="visually-hidden">Filter backups by wipe</legend>
            <ChoiceChip onClick={() => model.setFilter(null)} pressed={model.filter === null}>All wipes</ChoiceChip>
            {[...model.wipes].reverse().map((wipe) => <ChoiceChip key={wipe.id} onClick={() => model.setFilter(wipe.id)} pressed={model.filter === wipe.id}>Wipe #{wipe.number}</ChoiceChip>)}
          </fieldset>
        </div>
      )}
      {inventory.status === "error" && inventory.kind === "unavailable" && <NotConnected title="The backup inventory is not connected yet" />}
      {inventory.status === "error" && inventory.kind !== "unavailable" && <div style={{ padding: 16 }}><Banner actions={<ActionButton action={inventory.retry} variant="text" />} description={inventory.error} title="The inventory is unavailable" tone="error" /></div>}
      {inventory.status !== "error" && <DataTable
        columns={columns}
        empty={<EmptyState icon="backup" title="No verified backups" />}
        label={`Verified backups of ${worldName}`}
        loading={inventory.status === "loading"}
        rowKey={(entry) => entry.key}
        rows={inventory.status === "ready" ? inventory.value.entries : []}
      />}
      {inventory.status === "ready" && (inventory.value.unverified > 0 || inventory.value.truncated) && (
        <div style={{ padding: "0 16px 16px" }}>
          <Banner
            description={partialInventoryDescription(inventory.value.unverified, inventory.value.truncated)}
            title="Inventory is partial"
            tone="warning"
          />
        </div>
      )}
    </Card>
  );
}

function ReleasesTab({ rows, worldName }: Readonly<{ rows: readonly ReleaseRow[]; worldName: string }>) {
  const columns: Column<ReleaseRow>[] = [
    { id: "release", label: "Release", render: (row) => <span className="release-line">
      {row.sourceHref ? <a className="preset-source" href={row.sourceHref} rel="noreferrer" target="_blank" title="Open preset repository"><code>{row.name}</code><Icon name="open_in_new" size={14} /></a> : <code>{row.name}</code>}
      <Tooltip text={row.status === "Desired" ? "Desired, not yet active" : row.status}>
        <Icon className={row.status === "Desired" ? "release-state-pending" : "release-state-active"} name={row.status === "Desired" ? "schedule" : "verified"} size={18} />
        <span className="visually-hidden">{row.status}</span>
      </Tooltip>
      {row.download && <ActionButton action={row.download} size="small" variant="text" />}
    </span> },
  ];
  return (
    <Card flush>
      <DataTable columns={columns} empty={<EmptyState icon="inventory" title="No release" />} label={`Release pointer of ${worldName}`} rowKey={(row) => row.name} rows={rows} />
    </Card>
  );
}

function copyValueAction(id: string, label: string, value: string): Action {
  return action(id, label, () => { void navigator.clipboard?.writeText(value); }, { icon: "content_copy" });
}
