import { useEffect, useMemo, useState } from "react";

import { Button } from "../components/ui/Button";
import { DataColumn, DataTable } from "../components/ui/DataTable";
import { Tabs } from "../components/ui/Tabs";
import type { World } from "../model";
import { loadBackups, type BackupInventory } from "../auth";

type ReleaseRow = { name: string; status: string };

export type PackUploadRequest = Readonly<{
  file: File;
  release: string;
  gameVersion: string;
  loaderVersion: string;
}>;

export function StorageScreen({ world, gameId, canReadBackups, onDownloadPack, onUploadPack }: {
  world: World;
  gameId: string;
  canReadBackups: boolean;
  onDownloadPack?: (worldId: string) => void;
  onUploadPack?: (request: PackUploadRequest) => void;
}) {
  const [tab, setTab] = useState<"releases" | "backups">("releases");
  const [file, setFile] = useState<File | null>(null);
  const [release, setRelease] = useState("");
  const [gameVersion, setGameVersion] = useState("");
  const [loaderVersion, setLoaderVersion] = useState("");
  const [backups, setBackups] = useState<BackupInventory | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  // Loaded when the tab is opened rather than with the screen: an inventory is
  // a listing per world, and nobody pays for it while reading releases.
  useEffect(() => {
    if (tab !== "backups" || !canReadBackups) return;
    let current = true;
    setBackupError(null);
    loadBackups(gameId, world.id)
      .then((inventory) => { if (current) setBackups(inventory); })
      .catch((error: unknown) => { if (current) setBackupError(error instanceof Error ? error.message : "Unavailable"); });
    return () => { current = false; };
  }, [tab, canReadBackups, gameId, world.id]);
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
    <div className="page-heading"><h1>Releases</h1><p>Release pointers and verified backups for {world.displayName}</p></div>
    <Tabs label="Storage view" onChange={setTab} options={[{ id: "releases", label: "Releases" }, { id: "backups", label: "Backups" }]} value={tab} />
    {tab === "releases" && onUploadPack !== undefined && <form className="pack-upload" onSubmit={(event) => {
      event.preventDefault();
      if (file === null) return;
      onUploadPack({ file, release, gameVersion, loaderVersion });
    }}>
      <strong>Publish a pack you already have</strong>
      <p>The archive holds the mod files, flat or inside one mods/ folder. It uploads straight to storage and becomes an immutable release; nothing is deployed until you promote it.</p>
      <div className="pack-upload-fields">
        <input accept=".zip,application/zip" aria-label="Pack archive" onChange={(event) => setFile(event.target.files?.[0] ?? null)} type="file" />
        <input aria-label="Release number" onChange={(event) => setRelease(event.target.value)} placeholder="Release, e.g. 1.2" value={release} />
        <input aria-label="Game version" onChange={(event) => setGameVersion(event.target.value)} placeholder="Game version" value={gameVersion} />
        <input aria-label="Loader version" onChange={(event) => setLoaderVersion(event.target.value)} placeholder="Loader version" value={loaderVersion} />
        <Button disabled={file === null || release === "" || gameVersion === "" || loaderVersion === ""} type="submit" variant="primary">Upload and publish</Button>
      </div>
    </form>}
    {tab === "releases" && <DataTable columns={columns} emptyLabel={world.release.state === "unconfigured" ? "This world has no release pointer yet" : "Release data is unavailable"} label="Release pointers" rowKey={(row) => row.name} rows={releases} />}
    {tab === "backups" && !canReadBackups && <div className="empty-state"><strong>Your role cannot read backups</strong><p>Ask an owner for the backup.read permission.</p></div>}
    {tab === "backups" && canReadBackups && backupError !== null && <div className="empty-state"><strong>The inventory is unavailable</strong><p>{backupError}</p></div>}
    {tab === "backups" && canReadBackups && backupError === null && <>
      <DataTable
        columns={backupColumns}
        emptyLabel={backups === null ? "Reading the inventory…" : "This world has no verified backups yet"}
        label="Verified backups"
        rowKey={(row) => row.key}
        rows={backups?.entries ?? []}
      />
      {backups !== null && (backups.unverified > 0 || backups.truncated) && <p className="muted">
        {backups.unverified > 0 && `${backups.unverified} object${backups.unverified === 1 ? "" : "s"} in this world's archive prefix could not be verified from the listing and are not shown. `}
        {backups.truncated && "Older backups exist beyond the newest shown."}
      </p>}
    </>}
  </>;
}
