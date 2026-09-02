import { useEffect, useMemo, useState } from "react";

import { Button } from "../components/ui/Button";
import { DataColumn, DataTable } from "../components/ui/DataTable";
import { Tabs } from "../components/ui/Tabs";
import type { World } from "../model";
import { loadBackups, type BackupInventory } from "../auth";
import { EmptyState, Notice, PageHeader, RetryState } from "../components/ui/Page";

type ReleaseRow = { name: string; status: string };

export function StorageScreen({ world, gameId, canReadBackups, onDownloadPack, request }: {
  world: World;
  gameId: string;
  canReadBackups: boolean;
  onDownloadPack?: (worldId: string) => void;
  request: { state: "idle" | "pending" | "success" | "error"; message: string };
}) {
  const [tab, setTab] = useState<"releases" | "backups">("releases");
  const [backups, setBackups] = useState<BackupInventory | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupRevision, setBackupRevision] = useState(0);

  // Loaded when the tab is opened rather than with the screen: an inventory is
  // a listing per world, and nobody pays for it while reading releases.
  useEffect(() => {
    if (tab !== "backups" || !canReadBackups) return;
    let current = true;
    setBackups(null);
    setBackupError(null);
    loadBackups(gameId, world.id)
      .then((inventory) => { if (current) setBackups(inventory); })
      .catch((error: unknown) => { if (current) setBackupError(error instanceof Error ? error.message : "Unavailable"); });
    return () => { current = false; };
  }, [tab, canReadBackups, gameId, world.id, backupRevision]);
  const releases = useMemo<ReleaseRow[]>(() => {
    const rows = new Map<string, ReleaseRow>();
    if (world.release.activeRelease) rows.set(world.release.activeRelease, { name: world.release.activeRelease, status: "Active" });
    if (world.release.desiredRelease) rows.set(world.release.desiredRelease, {
      name: world.release.desiredRelease,
      status: world.release.desiredRelease === world.release.activeRelease ? "Active and desired" : "Desired",
    });
    return [...rows.values()];
  }, [world]);
  const columns: DataColumn<ReleaseRow>[] = [
    { id: "name", label: "Release", render: (row) => <strong>{row.name}</strong>, width: "1.4fr" },
    { id: "status", label: "Pointer status", render: (row) => row.status, width: "1fr" },
    {
      // The pack is what a player installs to be able to join, so it belongs
      // beside the release rather than in an operator screen. The link is
      // presigned per request and nothing about it is kept here.
      id: "pack",
      label: "Client pack",
      render: (row) =>
        row.status === "Desired" || onDownloadPack === undefined
          ? <span className="muted">Available once active</span>
          : <Button onClick={() => onDownloadPack(world.id)}>Download</Button>,
      width: "1fr",
    },
  ];

  const backupColumns: DataColumn<BackupInventory["entries"][number]>[] = [
    { id: "archive", label: "Archive", render: (row) => <strong>{row.archiveName}</strong>, width: "1.6fr" },
    { id: "stored", label: "Stored", render: (row) => new Date(row.storedAt).toLocaleString(), width: "1.2fr" },
    { id: "size", label: "Size", render: (row) => `${(row.sizeBytes / 1048576).toFixed(1)} MiB`, width: "0.8fr" },
    // The digest is the key: showing its head is enough to compare two rows,
    // and the whole thing is available by copying the archive name.
    { id: "checksum", label: "SHA-256", render: (row) => <code>{row.checksum.slice(0, 12)}…</code>, width: "0.9fr" },
  ];

  return <>
    <PageHeader description={`Release pointers and verified backups for ${world.displayName}`} title="Releases" />
    <Tabs label="Storage view" onChange={setTab} options={[{ id: "releases", label: "Releases" }, { id: "backups", label: "Backups" }]} value={tab} />
    {tab === "releases" && request.state !== "idle" && <Notice description={request.message} title={request.state === "pending" ? "Working on the pack" : request.state === "success" ? "Pack request accepted" : "Pack request failed"} tone={request.state === "error" ? "danger" : request.state === "success" ? "success" : "info"} />}
    {tab === "releases" && <DataTable columns={columns} emptyLabel={world.release.state === "unconfigured" ? "This world has no release pointer yet" : "Release data is unavailable"} label="Release pointers" rowKey={(row) => row.name} rows={releases} />}
    {tab === "backups" && !canReadBackups && <EmptyState description="Ask an owner for the backup.read permission." icon="storage" title="Your role cannot read backups" />}
    {tab === "backups" && canReadBackups && backupError !== null && <RetryState description={backupError} onRetry={() => setBackupRevision((current) => current + 1)} title="The inventory is unavailable" />}
    {tab === "backups" && canReadBackups && backupError === null && <>
      <DataTable
        columns={backupColumns}
        emptyLabel={backups === null ? "Reading the inventory…" : "This world has no verified backups yet"}
        label="Verified backups"
        rowKey={(row) => row.key}
        rows={backups?.entries ?? []}
      />
      {backups !== null && (backups.unverified > 0 || backups.truncated) && <Notice description={`${backups.unverified > 0 ? `${backups.unverified} object${backups.unverified === 1 ? "" : "s"} could not be verified and ${backups.unverified === 1 ? "is" : "are"} not shown. ` : ""}${backups.truncated ? "Older backups exist beyond the newest shown." : ""}`} title="Inventory is partial" tone="warning" />}
    </>}
  </>;
}
