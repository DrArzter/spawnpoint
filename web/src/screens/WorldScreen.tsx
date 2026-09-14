import { useEffect, useMemo, useState } from "react";

import { BackupInventory, loadBackups } from "../auth";
import { Button } from "../components/ui/Button";
import { Chip, ChoiceChip } from "../components/ui/Chip";
import { Column, DataTable } from "../components/ui/DataTable";
import { Menu, MenuItem } from "../components/ui/Menu";
import { hostStatus, sessionStatus, Status, worldStatus } from "../components/ui/Status";
import { Banner, Card, CopyButton, DetailItem, DetailsGroup, EmptyState, Ghost, PageHeader } from "../components/ui/Surfaces";
import { Tabs } from "../components/ui/Tabs";
import { Icon } from "../icons";
import { formatBytes, formatDate, formatDateTime, formatTime, repositoryName, shortCommit, shortDigest } from "../lib/format";
import type { ControlPlaneSnapshot, Game, Operation, ServerState, Wipe, World } from "../model";
import { routeHash } from "../routing";
import type { SharedHostSession } from "../session";
import { Pending, pendingFor, SessionAction, WorldActionKind } from "../shell/actions";
import { releaseSummary, sessionActionForWorld, sessionControlAvailability, SharedHostNotice } from "./WorldsScreen";

type Tab = "details" | "wipes" | "backups" | "releases";

export function WorldScreen({ game, world, snapshot, serverState, sharedSession, granted, pending, onRefresh, onSessionAction, onWorldAction, onInvite, onDownloadPack }: {
  game: Game;
  world: World;
  snapshot: ControlPlaneSnapshot | null;
  serverState: ServerState;
  sharedSession: SharedHostSession;
  granted: ReadonlySet<string>;
  pending: Pending | null;
  onRefresh: () => void;
  onSessionAction: (game: Game, world: World, action: SessionAction) => void;
  onWorldAction: (game: Game, world: World, action: WorldActionKind, backup?: { key: string; name: string }) => void;
  onInvite: (game: Game, world: World) => void;
  onDownloadPack: (game: Game, world: World) => void;
}) {
  const [tab, setTab] = useState<Tab>("details");
  const [wipeFilter, setWipeFilter] = useState<string | null>(null);
  useEffect(() => { setTab("details"); setWipeFilter(null); }, [world.id]);

  const rowPending = pendingFor(pending, world.id);
  const busy = rowPending !== null;
  const controlBusy = pending?.kind === "session" || pending?.kind === "lifecycle";
  const action: SessionAction = sessionActionForWorld(world, game, sharedSession);
  const permitted = granted.has(action === "start" ? "session.start" : "session.stop");
  const sessionControl = sessionControlAvailability(world, game, sharedSession, permitted, controlBusy || busy);
  const canManage = granted.has("world.manage");
  const preset = game.presets.find((item) => item.id === (world.preset?.id ?? world.profileId));
  const currentWipe = world.wipes.find((wipe) => wipe.state === "current") ?? world.wipes.at(-1);
  const host = snapshot?.hosts[0];
  const session = sessionStatus(serverState);
  const availability = worldStatus(world);
  const operations = snapshot?.operations ?? [];

  const menu: (MenuItem | "separator")[] = [];
  if (granted.has("connection.read")) menu.push({ id: "pack", label: "Download client pack", icon: "download", disabled: !world.release.activeRelease || busy, title: world.release.activeRelease ? `Pack for release ${world.release.activeRelease}` : "Available once a release is active", onSelect: () => onDownloadPack(game, world) });
  if (canManage && world.worldLifecycleAvailable) {
    if (menu.length > 0) menu.push("separator");
    if (world.materialization === "existing") {
      menu.push({ id: "wipe", label: "Start a new wipe", detail: preset?.latestRelease ? `From ${preset.displayName} ${preset.latestRelease}` : "Needs a built release", icon: "history", disabled: busy || !preset?.latestRelease, onSelect: () => onWorldAction(game, world, "wipe") });
      menu.push({ id: "archive", label: "Archive this world", detail: "Stops, backs up, hides from session control", icon: "archive", disabled: busy, onSelect: () => onWorldAction(game, world, "archive") });
    }
    if (world.materialization === "archived") menu.push({ id: "purge", label: "Delete permanently", detail: "Registry, pointer and every backup", icon: "delete_forever", danger: true, disabled: busy, onSelect: () => onWorldAction(game, world, "purge") });
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [{ id: "details", label: "Details" }];
  if (world.worldLifecycleAvailable) tabs.push({ id: "wipes", label: "Wipes", count: world.wipes.length });
  tabs.push({ id: "backups", label: "Backups" });
  if (granted.has("release.read")) tabs.push({ id: "releases", label: "Releases" });

  const sessionDetails: DetailItem[] = [
    { label: "Session", value: <Status kind={session.kind} label={session.label} />, hint: `${game.displayName} runs one session at a time on the shared host` },
    { label: "Desired and observed", value: <span className="pair"><strong>{game.lifecycle?.desiredState ?? "unknown"}</strong><Icon name="chevron_right" size={16} /><strong>{game.lifecycle?.observedState ?? "unknown"}</strong></span>, hint: game.lifecycle ? `Lifecycle updated ${formatDateTime(game.lifecycle.updatedAtEpochSeconds)}` : "No lifecycle record for this game" },
    { label: "Compute host", value: host ? <Status kind={hostStatus(host.state).kind} label={`${host.name} · ${hostStatus(host.state).label.toLowerCase()}`} /> : <Ghost>No host available</Ghost>, hint: host?.instanceType ? `${host.instanceType}${host.availabilityZone ? ` in ${host.availabilityZone}` : ""}` : undefined },
    { label: "Last observed", value: formatDateTime(snapshot?.observedAt) },
  ];
  const worldDetails: DetailItem[] = [
    { label: "World ID", value: world.id, mono: true, copy: world.id },
    { label: "Availability", value: <Status kind={availability.kind} label={availability.label} />, hint: world.worldLifecycleAvailable ? "Wipe-managed world" : "Legacy world without wipe management" },
    { label: "Preset", value: preset ? <span>{preset.displayName}</span> : <span>{world.profileId}</span>, hint: world.preset ? <span className="mono">{repositoryName(world.preset.repository)} @ {shortCommit(world.preset.commit)}</span> : "Not built from a Git preset" },
    { label: "Release", value: world.release.activeRelease || world.release.desiredRelease ? <span className="pair"><span>Active <strong>{world.release.activeRelease ?? "none"}</strong></span><Icon name="chevron_right" size={16} /><span>Desired <strong>{world.release.desiredRelease ?? "none"}</strong></span></span> : <Ghost>{releaseSummary(world)}</Ghost>, hint: `Pointer ${world.release.state}` },
    { label: "Current wipe", value: currentWipe ? <span>#{currentWipe.number}</span> : <Ghost>{world.worldLifecycleAvailable ? "No wipes yet" : "Not tracked"}</Ghost>, hint: currentWipe ? `Opened ${formatDate(currentWipe.createdAt)} on release ${currentWipe.originRelease}` : undefined },
    { label: "Connectivity", value: world.connectivity === "zerotier" ? "ZeroTier network" : "Public address" },
    { label: "Address", value: world.connectionAddress ? <code>{world.connectionAddress}</code> : <Ghost>{world.materialization !== "existing" ? "No address" : serverState === "running" ? "No address yet" : "Assigned while online"}</Ghost>, copy: world.connectionAddress ?? undefined, hint: world.connectionAddress ? "The host part plus the game port, read from the control plane" : undefined },
  ];

  const operationColumns: Column<Operation>[] = [
    { id: "operation", label: "Operation", render: (operation) => <strong>{operationLabel(operation.type)}</strong> },
    { id: "execution", label: "Execution", render: (operation) => <code>{operation.id}</code> },
    { id: "started", label: "Started", width: "140px", render: (operation) => <span className="num">{formatTime(operation.startedAt)}</span> },
    { id: "status", label: "Status", width: "140px", render: () => <Status kind="progress" label="Running" /> },
  ];

  return (
    <div className="page">
      <PageHeader
        actions={<div className="world-actions">
          <Button icon="refresh" loading={pending?.kind === "refresh"} onClick={onRefresh} variant="outlined">Refresh</Button>
          {granted.has("invitation.send") && <Button icon="send" onClick={() => onInvite(game, world)} variant="outlined">Invite players</Button>}
          <span className="action-group">
            <Button
              aria-label={`${action === "stop" ? "Stop" : "Start"} ${world.displayName}. ${sessionControl.hint}`}
              disabled={sessionControl.disabled}
              icon={action === "stop" ? "stop" : "play_arrow"}
              loading={rowPending?.kind === "session"}
              onClick={() => onSessionAction(game, world, action)}
              title={sessionControl.hint}
              variant={action === "stop" ? "danger" : "filled"}
            >
              {action === "stop" ? "Stop" : "Start"}
            </Button>
            {menu.length > 0 && <Menu items={menu} label={`More actions for ${world.displayName}`} />}
          </span>
        </div>}
        breadcrumb={[{ label: "Worlds", href: routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: null }) }]}
        status={<Status kind={availability.kind} label={availability.label} />}
        title={world.displayName}
      />
      {world.materialization === "archived" && <Banner description="Restore one of its backups to open a new wipe, or delete it permanently from the actions menu." title="This world is archived" tone="warning" />}
      {rowPending?.kind === "lifecycle" && <Banner description={`Spawnpoint is requesting ${rowPending.action === "wipe" ? "a new wipe" : rowPending.action}. The operation appears in the table below once accepted.`} title="World operation in progress" tone="info" />}
      <SharedHostNotice busy={controlBusy} session={sharedSession} />

      <div className="world-tabs">
        <Tabs label="World sections" onChange={setTab} options={tabs} value={tab} />

        {tab === "details" && <>
          <Card>
            <div className="details-columns">
              <DetailsGroup items={sessionDetails} title="Session" />
              <DetailsGroup items={worldDetails} title="World" />
            </div>
          </Card>
          <Card description="Step Functions executions affecting the control plane right now." flush title="Operations">
            <DataTable
              columns={operationColumns}
              empty={<EmptyState description="Completed executions will be listed after the operations API exposes history. Spawnpoint shows only what it observes." icon="sync" title="No operation in progress" />}
              label="Running operations"
              rowKey={(operation) => `${operation.type}-${operation.id}`}
              rows={operations}
            />
          </Card>
        </>}

        {tab === "wipes" && <WipesTab onShowBackups={(wipe) => { setWipeFilter(wipe.id); setTab("backups"); }} world={world} />}

        {tab === "backups" && <BackupsTab
          busy={busy}
          canRead={granted.has("backup.read")}
          canRestore={granted.has("backup.restore")}
          filter={wipeFilter}
          gameId={game.id}
          onFilter={setWipeFilter}
          onRestore={(entry) => onWorldAction(game, world, "restore", { key: entry.key, name: entry.archiveName })}
          settled={`${world.wipes.length}:${operations.length}`}
          world={world}
        />}

        {tab === "releases" && <ReleasesTab busy={busy} canDownload={granted.has("connection.read")} onDownload={() => onDownloadPack(game, world)} world={world} />}
      </div>
    </div>
  );
}

function WipesTab({ world, onShowBackups }: Readonly<{ world: World; onShowBackups: (wipe: Wipe) => void }>) {
  const columns: Column<Wipe>[] = [
    { id: "wipe", label: "Wipe", width: "120px", render: (wipe) => <strong className="num">#{wipe.number}</strong> },
    { id: "status", label: "Status", width: "140px", render: (wipe) => wipe.state === "current" ? <Chip tone="primary">Current</Chip> : <Chip tone="tonal">Closed</Chip> },
    { id: "release", label: "Started on release", render: (wipe) => <code>{wipe.originRelease}</code> },
    { id: "opened", label: "Opened", render: (wipe) => <span className="num">{formatDateTime(wipe.createdAt)}</span> },
    { id: "closed", label: "Closed", render: (wipe) => wipe.closedAt ? <span className="num">{formatDateTime(wipe.closedAt)}</span> : <Ghost>Open</Ghost> },
    { id: "actions", label: "Actions", actions: true, render: (wipe) => <Button onClick={() => onShowBackups(wipe)} size="small" variant="text">Backups</Button> },
  ];
  return (
    <Card description="Each wipe is a generation of this world; backups belong to the wipe they were taken from." flush title="Wipes">
      <DataTable columns={columns} empty={<EmptyState description="The first start opens wipe #1." icon="history" title="No wipes yet" />} label={`Wipes of ${world.displayName}`} rowKey={(wipe) => wipe.id} rows={[...world.wipes].reverse()} />
    </Card>
  );
}

function BackupsTab({ world, gameId, canRead, canRestore, busy, filter, onFilter, onRestore, settled }: {
  world: World;
  gameId: string;
  /** Changes when a wipe lands or an operation finishes, so the listing refetches. */
  settled: string;
  canRead: boolean;
  canRestore: boolean;
  busy: boolean;
  filter: string | null;
  onFilter: (wipeId: string | null) => void;
  onRestore: (entry: BackupInventory["entries"][number]) => void;
}) {
  const [inventory, setInventory] = useState<BackupInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => setInventory(null), [gameId, world.id]);

  // Loaded when the tab opens, and again once an operation settles: a stop, a
  // wipe and a restore each leave a new archive behind. An inventory is a
  // listing per world, so nobody pays for it while reading other tabs.
  useEffect(() => {
    if (!canRead) return;
    let current = true;
    setError(null);
    loadBackups(gameId, world.id)
      .then((result) => { if (current) setInventory(result); })
      .catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : "The backup inventory is unavailable."); });
    return () => { current = false; };
  }, [canRead, gameId, world.id, revision, settled]);

  const entries = useMemo(() => (inventory?.entries ?? []).filter((entry) => filter === null || entry.generationId === filter), [inventory, filter]);
  const wipeNumber = (generationId: string | null) => world.wipes.find((wipe) => wipe.id === generationId)?.number;
  const columns: Column<BackupInventory["entries"][number]>[] = [
    { id: "archive", label: "Archive", render: (entry) => <span className="copy-value"><code>{entry.archiveName}</code><CopyButton label={`Copy the archive name ${entry.archiveName}`} value={entry.archiveName} /></span> },
    { id: "wipe", label: "Wipe", width: "100px", render: (entry) => { const number = wipeNumber(entry.generationId); return number !== undefined ? <span className="num">#{number}</span> : <Ghost>Legacy</Ghost>; } },
    { id: "stored", label: "Stored", render: (entry) => <span className="num">{formatDateTime(entry.storedAt)}</span> },
    { id: "size", label: "Size", width: "110px", align: "num", render: (entry) => formatBytes(entry.sizeBytes) },
    { id: "checksum", label: "SHA-256", width: "210px", render: (entry) => <span className="copy-value"><code title={entry.checksum}>{shortDigest(entry.checksum)}</code><CopyButton label="Copy the full checksum" value={entry.checksum} /></span> },
    {
      id: "actions",
      label: "Actions",
      actions: true,
      render: (entry) => (
        <Button
          disabled={!world.worldLifecycleAvailable || !canRestore || entry.generationId === null || busy}
          icon="restore"
          onClick={() => onRestore(entry)}
          size="small"
          title={!world.worldLifecycleAvailable ? "This legacy world is not wipe-managed." : entry.generationId === null ? "This legacy backup is not tied to a wipe." : canRestore ? "Restore into a new wipe" : "Your role cannot restore backups."}
          variant="text"
        >
          Restore
        </Button>
      ),
    },
  ];

  if (!canRead) {
    return <Card flush title="Backups"><EmptyState description="Ask an owner for the backup.read permission to list verified backups." icon="lock" title="Your role cannot read backups" /></Card>;
  }

  return (
    <Card description="Verified archives in S3. Restoring one opens a new wipe; nothing here is overwritten." flush title="Backups">
      {world.wipes.length > 0 && (
        <div className="filter-bar">
          <Icon name="filter_list" size={20} />
          <div aria-label="Filter backups by wipe" className="chip-row" role="group">
            <ChoiceChip onClick={() => onFilter(null)} pressed={filter === null}>All wipes</ChoiceChip>
            {[...world.wipes].reverse().map((wipe) => <ChoiceChip key={wipe.id} onClick={() => onFilter(wipe.id)} pressed={filter === wipe.id}>Wipe #{wipe.number}</ChoiceChip>)}
          </div>
        </div>
      )}
      {error !== null && <div style={{ padding: 16 }}><Banner actions={<Button onClick={() => setRevision((value) => value + 1)} variant="text">Try again</Button>} description={error} title="The inventory is unavailable" tone="error" /></div>}
      {error === null && <DataTable
        columns={columns}
        empty={<EmptyState description={filter ? "This wipe has no verified backups yet." : "Backups are taken at every safe stop and before every wipe."} icon="backup" title="No verified backups" />}
        label={`Verified backups of ${world.displayName}`}
        loading={inventory === null}
        rowKey={(entry) => entry.key}
        rows={entries}
      />}
      {inventory !== null && (inventory.unverified > 0 || inventory.truncated) && (
        <div style={{ padding: "0 16px 16px" }}>
          <Banner
            description={`${inventory.unverified > 0 ? `${inventory.unverified} object${inventory.unverified === 1 ? "" : "s"} could not be verified and ${inventory.unverified === 1 ? "is" : "are"} not shown. ` : ""}${inventory.truncated ? "Older backups exist beyond the newest shown." : ""}`}
            title="Inventory is partial"
            tone="warning"
          />
        </div>
      )}
    </Card>
  );
}

type ReleaseRow = { name: string; status: string; downloadable: boolean };

function ReleasesTab({ world, canDownload, busy, onDownload }: { world: World; canDownload: boolean; busy: boolean; onDownload: () => void }) {
  const rows = useMemo<ReleaseRow[]>(() => {
    const map = new Map<string, ReleaseRow>();
    if (world.release.activeRelease) map.set(world.release.activeRelease, { name: world.release.activeRelease, status: "Active", downloadable: true });
    if (world.release.desiredRelease) {
      map.set(world.release.desiredRelease, {
        name: world.release.desiredRelease,
        status: world.release.desiredRelease === world.release.activeRelease ? "Active and desired" : "Desired",
        downloadable: world.release.desiredRelease === world.release.activeRelease,
      });
    }
    return [...map.values()];
  }, [world.release.activeRelease, world.release.desiredRelease]);
  const columns: Column<ReleaseRow>[] = [
    { id: "release", label: "Release", render: (row) => <code>{row.name}</code> },
    { id: "status", label: "Pointer status", render: (row) => row.status === "Desired" ? <Status kind="pending" label="Desired, not yet active" /> : <Status kind="ok" label={row.status} /> },
    {
      id: "pack",
      label: "Client pack",
      actions: true,
      render: (row) => row.downloadable && canDownload
        ? <Button disabled={busy} icon="download" onClick={onDownload} size="small" variant="text">Download</Button>
        : <Ghost>{canDownload ? "Available once active" : "Needs connection.read"}</Ghost>,
    },
  ];
  return (
    <Card description="The pointer names the release this world runs. The client pack is what a player installs to join; links are presigned for an hour." flush title="Release pointer">
      <DataTable columns={columns} empty={<EmptyState description={world.release.state === "unconfigured" ? "This world has no release pointer yet." : "Release data is unavailable."} icon="inventory" title="No release" />} label={`Release pointer of ${world.displayName}`} rowKey={(row) => row.name} rows={rows} />
    </Card>
  );
}

function operationLabel(type: Operation["type"]): string {
  return type === "start" ? "Starting session" : type === "stop" ? "Stopping session" : type === "world" ? "Updating world" : "Promoting release";
}
