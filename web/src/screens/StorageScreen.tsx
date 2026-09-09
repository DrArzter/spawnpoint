import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../components/ui/Button";
import { DataColumn, DataTable } from "../components/ui/DataTable";
import { Tabs } from "../components/ui/Tabs";
import type { World } from "../model";
import { loadBackups, type BackupInventory } from "../auth";
import { EmptyState, Notice, PageHeader, RetryState, Surface } from "../components/ui/Page";

type ReleaseRow = { name: string; status: string };

type RequestState = { state: "idle" | "pending" | "success" | "error"; message: string };
type WorldAction = { action: "archive" | "regenerate" | "restore"; backupKey?: string; backupName?: string };

export function StorageScreen({ world, gameId, canReadBackups, canManageWorld, canRestoreBackup, onDownloadPack, onWorldAction, packRequest, lifecycleRequest }: {
  world: World;
  gameId: string;
  canReadBackups: boolean;
  canManageWorld: boolean;
  canRestoreBackup: boolean;
  onDownloadPack?: (worldId: string) => void;
  onWorldAction: (action: "archive" | "regenerate" | "restore", backupKey?: string) => void;
  packRequest: RequestState;
  lifecycleRequest: RequestState;
}) {
  const [tab, setTab] = useState<"releases" | "backups">("releases");
  const [backups, setBackups] = useState<BackupInventory | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupRevision, setBackupRevision] = useState(0);
  const [confirming, setConfirming] = useState<WorldAction | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const actionTrigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirming === null) return;
    confirmButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirming(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      actionTrigger.current?.focus();
    };
  }, [confirming]);

  function requestConfirmation(action: WorldAction, trigger: HTMLButtonElement) {
    actionTrigger.current = trigger;
    setConfirming(action);
  }

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
    {
      id: "restore",
      label: "Action",
      render: (row) => <Button
        disabled={!world.worldLifecycleAvailable || !canRestoreBackup || row.generationId === null || lifecycleRequest.state === "pending"}
        onClick={(event) => requestConfirmation({ action: "restore", backupKey: row.key, backupName: row.archiveName }, event.currentTarget)}
        size="small"
        title={!world.worldLifecycleAvailable ? "This legacy world is not generation-managed." : row.generationId === null ? "This legacy backup is not tied to a generation." : canRestoreBackup ? "Restore into a new generation" : "Your role cannot restore backups."}
      >Restore</Button>,
      width: "0.6fr",
    },
  ];

  function confirmAction() {
    if (confirming === null) return;
    onWorldAction(confirming.action, confirming.backupKey);
    setConfirming(null);
  }

  const actionTitle = confirming?.action === "archive"
    ? "Archive this world?"
    : confirming?.action === "regenerate"
      ? "Create a fresh generation?"
      : "Restore this backup?";
  const actionDescription = confirming?.action === "archive"
    ? "Spawnpoint will safely stop and back up an active session, then hide the world from normal session control. Its generations and backups remain intact."
    : confirming?.action === "regenerate"
      ? "Spawnpoint will safely stop and back up the current generation, close it, and create an empty generation from the preset’s latest ready release."
      : `Spawnpoint will safely stop and back up the current generation, then restore ${confirming?.backupName ?? "the selected backup"} into a new generation.`;

  return <>
    <PageHeader actions={world.worldLifecycleAvailable && world.materialization === "existing" && <>
      {world.materialization === "existing" && <Button disabled={!canManageWorld || lifecycleRequest.state === "pending"} onClick={(event) => requestConfirmation({ action: "archive" }, event.currentTarget)}>Archive</Button>}
      {world.materialization === "existing" && <Button disabled={!canManageWorld || lifecycleRequest.state === "pending"} onClick={(event) => requestConfirmation({ action: "regenerate" }, event.currentTarget)} variant="danger">Regenerate</Button>}
    </>} description={`Release pointers and verified backups for ${world.displayName}`} title="Releases" />
    <Tabs label="Storage view" onChange={setTab} options={[{ id: "releases", label: "Releases" }, { id: "backups", label: "Backups" }]} value={tab} />
    {world.materialization === "archived" && <Notice description="Choose a generation-aware backup in the Backups tab to restore this world into a new active generation." title="This world is archived" tone="warning" />}
    {lifecycleRequest.state !== "idle" && <Notice description={lifecycleRequest.message} title={lifecycleRequest.state === "pending" ? "World operation requested" : lifecycleRequest.state === "success" ? "World operation accepted" : "World operation failed"} tone={lifecycleRequest.state === "error" ? "danger" : lifecycleRequest.state === "success" ? "success" : "info"} />}
    {confirming !== null && <Surface aria-describedby="world-operation-confirmation-description" aria-labelledby="world-operation-confirmation-title" className="operation-confirmation" role="alertdialog">
      <div><h2 id="world-operation-confirmation-title">{actionTitle}</h2><p id="world-operation-confirmation-description">{actionDescription}</p></div>
      <div><Button onClick={() => setConfirming(null)} variant="ghost">Cancel</Button><Button onClick={confirmAction} ref={confirmButton} variant={confirming.action === "archive" ? "primary" : "danger"}>{confirming.action === "archive" ? "Archive world" : confirming.action === "regenerate" ? "Create generation" : "Restore backup"}</Button></div>
    </Surface>}
    {tab === "releases" && packRequest.state !== "idle" && <Notice description={packRequest.message} title={packRequest.state === "pending" ? "Working on the pack" : packRequest.state === "success" ? "Pack request accepted" : "Pack request failed"} tone={packRequest.state === "error" ? "danger" : packRequest.state === "success" ? "success" : "info"} />}
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
