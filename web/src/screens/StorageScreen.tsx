import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "../components/ui/Button";
import { DataColumn, DataTable } from "../components/ui/DataTable";
import { Tabs } from "../components/ui/Tabs";
import type { Preset, Wipe, World } from "../model";
import { loadBackups, type BackupInventory } from "../auth";
import { EmptyState, Notice, PageHeader, RetryState, Surface } from "../components/ui/Page";

type ReleaseRow = { name: string; status: string; downloadable: boolean };

type RequestState = { state: "idle" | "pending" | "success" | "error"; message: string };
type WorldAction = { action: "archive" | "regenerate" | "restore" | "purge"; backupKey?: string; backupName?: string };

type StorageProps = {
  world?: World;
  preset?: Preset;
  gameId: string;
  canReadBackups: boolean;
  canManageWorld: boolean;
  canRestoreBackup: boolean;
  onDownloadPack?: (worldId: string) => void;
  onSelectWipe: (wipeId: string) => void;
  onWorldAction: (action: "archive" | "regenerate" | "restore" | "purge", backupKey?: string, release?: string) => void;
  onCreateWorld: (displayName: string, release: string) => Promise<void>;
  packRequest: RequestState;
  selectedWipeId?: string;
  lifecycleRequest: RequestState;
};

export function StorageScreen(props: StorageProps) {
  const { preset, world, canManageWorld, onCreateWorld } = props;
  const [creating, setCreating] = useState(world === undefined);
  const [name, setName] = useState("");
  const [release, setRelease] = useState(preset?.latestRelease ?? "");
  const [request, setRequest] = useState<RequestState>({ state: "idle", message: "" });

  useEffect(() => setRelease(preset?.latestRelease ?? ""), [preset?.id, preset?.latestRelease]);

  async function create() {
    if (!name.trim() || !preset || !preset.releases.includes(release)) return;
    setRequest({ state: "pending", message: "Creating the first wipe…" });
    try {
      await onCreateWorld(name.trim(), release);
      setRequest({ state: "success", message: `${name.trim()} was created.` });
      setName("");
      setCreating(false);
    } catch (error) {
      setRequest({ state: "error", message: error instanceof Error ? error.message : "The save could not be created." });
    }
  }

  const creator = creating && preset && <Surface className="create-world-form">
    <div><h2>Create a new save</h2><p>Spawnpoint will open Wipe #1 from the selected immutable {preset.displayName} release.</p></div>
    <label>Name<input autoComplete="off" maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Rostik" value={name} /></label>
    <label>Release<select onChange={(event) => setRelease(event.target.value)} value={release}><option disabled value="">Choose release</option>{[...preset.releases].reverse().map((version) => <option key={version} value={version}>{version}{version === preset.latestRelease ? " · latest" : ""}</option>)}</select></label>
    <div><Button onClick={() => setCreating(false)} variant="ghost">Cancel</Button><Button disabled={!canManageWorld || preset.buildStatus !== "ready" || !preset.releases.includes(release) || !name.trim() || request.state === "pending"} onClick={() => void create()} variant="primary">Create save</Button></div>
  </Surface>;

  if (world === undefined && preset) return <>
    <PageHeader description={`${preset.displayName} · ${preset.latestRelease ? `latest release ${preset.latestRelease}` : preset.buildStatus}`} title="Releases" />
    {request.state === "error" && <Notice description={request.message} title="Save creation failed" tone="danger" />}
    {creator ?? <EmptyState action={<Button onClick={() => setCreating(true)}>Create save</Button>} description="This preset is reusable. Create as many independent saves as you need." icon="storage" title="No saves yet" />}
  </>;

  if (world === undefined) return <EmptyState description="Choose a preset or an existing save." icon="storage" title="Nothing selected" />;

  return <WorldStorageScreen {...props} onBeginCreate={() => setCreating(true)} creator={creator} world={world} />;
}

function WorldStorageScreen({ world, preset, gameId, canReadBackups, canManageWorld, canRestoreBackup, onDownloadPack, onSelectWipe, onWorldAction, packRequest, selectedWipeId, lifecycleRequest, onBeginCreate, creator }: StorageProps & { world: World; onBeginCreate: () => void; creator: ReactNode }) {
  const [tab, setTab] = useState<"releases" | "backups" | "wipes">("releases");
  const [backups, setBackups] = useState<BackupInventory | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupRevision, setBackupRevision] = useState(0);
  const [confirming, setConfirming] = useState<WorldAction | null>(null);
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const [wipeRelease, setWipeRelease] = useState(preset?.latestRelease ?? "");
  const confirmButton = useRef<HTMLButtonElement>(null);
  const purgeInput = useRef<HTMLInputElement>(null);
  const actionTrigger = useRef<HTMLButtonElement | null>(null);
  const currentWipe = world.wipes.find((wipe) => wipe.state === "current") ?? world.wipes.at(-1);
  const selectedWipe = world.wipes.find((wipe) => wipe.id === selectedWipeId) ?? currentWipe;

  useEffect(() => {
    if (confirming === null) return;
    if (confirming.action === "purge") purgeInput.current?.focus();
    else confirmButton.current?.focus();
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
    setPurgeConfirmation("");
    setConfirming(action);
    if (action.action === "regenerate") setWipeRelease(preset?.latestRelease ?? "");
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
    if (selectedWipe?.state === "closed") {
      return [{ name: selectedWipe.originRelease, status: "Wipe origin", downloadable: false }];
    }
    const rows = new Map<string, ReleaseRow>();
    if (world.release.activeRelease) rows.set(world.release.activeRelease, { name: world.release.activeRelease, status: "Active", downloadable: true });
    if (world.release.desiredRelease) rows.set(world.release.desiredRelease, {
      name: world.release.desiredRelease,
      status: world.release.desiredRelease === world.release.activeRelease ? "Active and desired" : "Desired",
      downloadable: world.release.desiredRelease === world.release.activeRelease,
    });
    return [...rows.values()];
  }, [selectedWipe, world.release.activeRelease, world.release.desiredRelease]);
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
        !row.downloadable || onDownloadPack === undefined
          ? <span className="muted">{selectedWipe?.state === "closed" ? "Historical wipe" : "Available once active"}</span>
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
  const wipeColumns: DataColumn<World["wipes"][number]>[] = [
    { id: "wipe", label: "Wipe", render: (row) => <strong>Wipe #{row.number}</strong>, width: "0.8fr" },
    { id: "release", label: "Started on", render: (row) => `Release ${row.originRelease}`, width: "0.9fr" },
    { id: "opened", label: "Opened", render: (row) => new Date(row.createdAt).toLocaleString(), width: "1.2fr" },
    { id: "state", label: "Status", render: (row) => row.state === "current" ? "Current" : row.closedAt ? `Closed ${new Date(row.closedAt).toLocaleDateString()}` : "Closed", width: "1fr" },
    { id: "view", label: "Action", render: (row) => <Button disabled={row.id === selectedWipe?.id} onClick={() => viewWipe(row.id)} size="small">{row.id === selectedWipe?.id ? "Viewing" : "View"}</Button>, width: "0.6fr" },
  ];
  const visibleBackups = filterBackupsByWipe(backups?.entries ?? [], selectedWipe);

  function confirmAction() {
    if (confirming === null) return;
    onWorldAction(confirming.action, confirming.backupKey, confirming.action === "regenerate" ? wipeRelease : undefined);
    setConfirming(null);
  }

  function viewWipe(wipeId: string) {
    onSelectWipe(wipeId);
    setTab("releases");
  }

  const actionTitle = confirming?.action === "archive"
    ? "Archive this world?"
    : confirming?.action === "regenerate"
      ? "Start a new wipe?"
      : confirming?.action === "purge"
        ? "Permanently delete this world?"
        : "Restore this backup?";
  const actionDescription = confirming?.action === "archive"
    ? "Spawnpoint will safely stop and back up an active session, then hide the world from normal session control. Its generations and backups remain intact."
    : confirming?.action === "regenerate"
      ? `Spawnpoint will safely stop and back up the current wipe, close it, and create an empty wipe from the selected ${preset?.displayName ?? "preset"} release.`
      : confirming?.action === "purge"
        ? "This permanently deletes the world registry, release pointer and every version of every S3 backup. This cannot be undone from the dashboard."
        : `Spawnpoint will safely stop and back up the current wipe, then restore ${confirming?.backupName ?? "the selected backup"} as a new wipe.`;

  return <>
    <PageHeader actions={<>{preset && <Button disabled={!canManageWorld} onClick={onBeginCreate}>Create another</Button>}{world.worldLifecycleAvailable && world.materialization === "existing" && <>
      {world.materialization === "existing" && <Button disabled={!canManageWorld || lifecycleRequest.state === "pending"} onClick={(event) => requestConfirmation({ action: "archive" }, event.currentTarget)}>Archive</Button>}
      {world.materialization === "existing" && <Button disabled={!canManageWorld || lifecycleRequest.state === "pending" || preset?.latestRelease == null} onClick={(event) => requestConfirmation({ action: "regenerate" }, event.currentTarget)} variant="danger">New wipe</Button>}
    </>}{world.worldLifecycleAvailable && world.materialization === "archived" && <Button disabled={!canManageWorld || lifecycleRequest.state === "pending"} onClick={(event) => requestConfirmation({ action: "purge" }, event.currentTarget)} variant="danger">Delete permanently</Button>}</>} description={`${selectedWipe ? `Wipe #${selectedWipe.number} · ` : ""}releases and verified backups for ${world.displayName}`} title="Releases" />
    {creator}
    <Tabs label="Storage view" onChange={setTab} options={[{ id: "releases", label: "Releases" }, { id: "wipes", label: "Wipes" }, { id: "backups", label: "Backups" }]} value={tab} />
    {world.materialization === "archived" && <Notice description="Choose a wipe-aware backup in the Backups tab to restore this save as a new wipe." title="This save is archived" tone="warning" />}
    {lifecycleRequest.state !== "idle" && <Notice description={lifecycleRequest.message} title={lifecycleRequest.state === "pending" ? "World operation requested" : lifecycleRequest.state === "success" ? "World operation accepted" : "World operation failed"} tone={lifecycleRequest.state === "error" ? "danger" : lifecycleRequest.state === "success" ? "success" : "info"} />}
    {confirming !== null && <Surface aria-describedby="world-operation-confirmation-description" aria-labelledby="world-operation-confirmation-title" className="operation-confirmation" role="alertdialog">
      <div><h2 id="world-operation-confirmation-title">{actionTitle}</h2><p id="world-operation-confirmation-description">{actionDescription}</p>{confirming.action === "regenerate" && preset && <label className="wipe-release">Release<select onChange={(event) => setWipeRelease(event.target.value)} value={wipeRelease}><option disabled value="">Choose release</option>{[...preset.releases].reverse().map((version) => <option key={version} value={version}>{version}{version === preset.latestRelease ? " · latest" : ""}</option>)}</select></label>}{confirming.action === "purge" && <label className="purge-confirmation">Type <code>{world.id}</code> to confirm<input autoComplete="off" onChange={(event) => setPurgeConfirmation(event.target.value)} ref={purgeInput} value={purgeConfirmation} /></label>}</div>
      <div><Button onClick={() => setConfirming(null)} variant="ghost">Cancel</Button><Button disabled={(confirming.action === "purge" && purgeConfirmation !== world.id) || (confirming.action === "regenerate" && !preset?.releases.includes(wipeRelease))} onClick={confirmAction} ref={confirmButton} variant={confirming.action === "archive" ? "primary" : "danger"}>{confirming.action === "archive" ? "Archive save" : confirming.action === "regenerate" ? "Start new wipe" : confirming.action === "purge" ? "Delete save forever" : "Restore backup"}</Button></div>
    </Surface>}
    {tab === "releases" && packRequest.state !== "idle" && <Notice description={packRequest.message} title={packRequest.state === "pending" ? "Working on the pack" : packRequest.state === "success" ? "Pack request accepted" : "Pack request failed"} tone={packRequest.state === "error" ? "danger" : packRequest.state === "success" ? "success" : "info"} />}
    {tab === "releases" && <DataTable columns={columns} emptyLabel={world.release.state === "unconfigured" ? "This wipe has no release pointer yet" : "Release data is unavailable"} label={selectedWipe ? `Releases for Wipe #${selectedWipe.number}` : "Release pointers"} rowKey={(row) => row.name} rows={releases} />}
    {tab === "wipes" && <DataTable columns={wipeColumns} emptyLabel="No wipe history is available for this save" label="Wipe history" rowKey={(row) => row.id} rows={[...world.wipes].reverse()} />}
    {tab === "backups" && !canReadBackups && <EmptyState description="Ask an owner for the backup.read permission." icon="storage" title="Your role cannot read backups" />}
    {tab === "backups" && canReadBackups && backupError !== null && <RetryState description={backupError} onRetry={() => setBackupRevision((current) => current + 1)} title="The inventory is unavailable" />}
    {tab === "backups" && canReadBackups && backupError === null && <>
      <DataTable
        columns={backupColumns}
        emptyLabel={backups === null ? "Reading the inventory…" : selectedWipe ? `Wipe #${selectedWipe.number} has no verified backups yet` : "This save has no verified backups yet"}
        label={selectedWipe ? `Verified backups for Wipe #${selectedWipe.number}` : "Verified backups"}
        rowKey={(row) => row.key}
        rows={visibleBackups}
      />
      {backups !== null && (backups.unverified > 0 || backups.truncated) && <Notice description={`${backups.unverified > 0 ? `${backups.unverified} object${backups.unverified === 1 ? "" : "s"} could not be verified and ${backups.unverified === 1 ? "is" : "are"} not shown. ` : ""}${backups.truncated ? "Older backups exist beyond the newest shown." : ""}`} title="Inventory is partial" tone="warning" />}
    </>}
  </>;
}

function filterBackupsByWipe(entries: BackupInventory["entries"], wipe: Wipe | undefined) {
  if (wipe === undefined) return entries;
  return entries.filter((entry) => entry.generationId === wipe.id);
}
