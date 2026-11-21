import type { BackupEntry } from "../../../api/contract";
import type { BackupsModel } from "../../../core/models";
import { formatBytes } from "../../../lib/format";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { Copy } from "../ui/Copy";
import { shortDateTime } from "../ui/DetailList";
import { Empty, LoadError } from "../ui/Empty";
import { Segmented } from "../ui/Segmented";
import { Table, type Column } from "../ui/Table";

const ALL = "all";

/** What the inventory leaves out, as one faint line; null when it lists everything. */
export function partialLine(unverified: number, truncated: boolean): string | null {
  const hidden = `${unverified} ${unverified === 1 ? "object" : "objects"} not shown`;
  const parts = [unverified > 0 ? hidden : null, truncated ? "older backups exist" : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function BackupsTab({ model }: Readonly<{ model: BackupsModel }>) {
  const options = [{ value: ALL, label: "All" }, ...model.wipes.map((wipe) => ({ value: wipe.id, label: `Wipe #${wipe.number}` }))];
  const filter = model.wipes.length > 0 && (
    <Segmented label="Wipe" onChange={(value) => model.setFilter(value === ALL ? null : value)} options={options} value={model.filter ?? ALL} />
  );
  return (
    <Card actions={model.canRead ? filter : undefined} body="flush" title="Backups">
      <Body model={model} />
    </Card>
  );
}

function Body({ model }: Readonly<{ model: BackupsModel }>) {
  if (!model.canRead) return <Empty icon="lock" title="Your role cannot read backups" />;
  const inventory = model.inventory;
  if (inventory.status === "error") return <LoadError error={inventory.error} kind={inventory.kind} retry={inventory.retry} title="Backups could not be loaded" verb="read backups" />;
  const ready = inventory.status === "ready" ? inventory.value : null;
  if (ready?.entries.length === 0) return <Empty icon="cloud_off" title="No backups" />;
  const download = model.download;
  const columns: Column<BackupEntry>[] = [
    { id: "time", header: "Time", kind: "lead", render: (entry) => <strong>{shortDateTime(entry.storedAt) ?? entry.storedAt}</strong> },
    ...(model.filter === null ? [{ id: "wipe", header: "Wipe", render: (entry: BackupEntry) => {
      const number = model.wipeNumber(entry.generationId);
      return number === undefined ? <span className="c-faint">—</span> : `#${number}`;
    } }] : []),
    { id: "size", header: "Size", kind: "num", render: (entry) => formatBytes(entry.sizeBytes) },
    { id: "checksum", header: "Checksum", kind: "wide", render: (entry) => (
      <span className="c-sum">
        <span className="c-mono" title={entry.checksum}>{entry.checksum.slice(0, 12)}</span>
        <Copy value={entry.checksum} what="checksum" />
      </span>
    ) },
    { id: "actions", header: "Actions", kind: "act", render: (entry) => (
      <>
        <ActionButton action={model.restore(entry)} size="sm" />
        {download && <ActionButton action={download(entry)} size="sm" />}
      </>
    ) },
  ];
  const line = ready && partialLine(ready.unverified, ready.truncated);
  return (
    <>
      <Table columns={columns} label="Backups" loading={ready === null} rowKey={(entry) => entry.key} rows={ready?.entries ?? []} />
      {line && <p className="c-line c-faint c-card-foot">{line}</p>}
    </>
  );
}
