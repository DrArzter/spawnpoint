import { useMemo, useState } from "react";

import { Button } from "../components/ui/Button";
import { DataColumn, DataTable } from "../components/ui/DataTable";
import { Tabs } from "../components/ui/Tabs";
import type { World } from "../model";

type ReleaseRow = { name: string; status: string };

export type PackUploadRequest = Readonly<{
  file: File;
  release: string;
  gameVersion: string;
  loaderVersion: string;
}>;

export function StorageScreen({ world, onDownloadPack, onUploadPack }: {
  world: World;
  onDownloadPack?: (worldId: string) => void;
  onUploadPack?: (request: PackUploadRequest) => void;
}) {
  const [tab, setTab] = useState<"releases" | "backups">("releases");
  const [file, setFile] = useState<File | null>(null);
  const [release, setRelease] = useState("");
  const [gameVersion, setGameVersion] = useState("");
  const [loaderVersion, setLoaderVersion] = useState("");
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
    {tab === "backups" && <div className="empty-state"><strong>Backup inventory is not connected yet</strong><p>The backup API will list only S3 objects whose metadata and checksum have been verified. No placeholder backups are shown.</p></div>}
  </>;
}
