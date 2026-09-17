import { useEffect, useMemo, useState } from "react";

import type { ApiFailureKind } from "../api/contract";
import { failureKind } from "../api/contract";
import { BackupInventory, loadBackups } from "../auth";
import { Button } from "../components/ui/Button";
import { Chip, ChoiceChip } from "../components/ui/Chip";
import { Column, DataTable } from "../components/ui/DataTable";
import { Ellipsis } from "../components/ui/Ellipsis";
import { Menu, MenuItem } from "../components/ui/Menu";
import { hostStatus, sessionStatus, Status, worldStatus } from "../components/ui/Status";
import { Banner, Card, CopyButton, DetailItem, DetailsGroup, EmptyState, Ghost, NotConnected, PageHeader } from "../components/ui/Surfaces";
import { Tabs } from "../components/ui/Tabs";
import { Timestamp } from "../components/ui/Timestamp";
import { Tooltip } from "../components/ui/Tooltip";
import { Icon } from "../icons";
import { formatBytes, formatDate, formatDateTime, formatTime, repositoryName, shortCommit, shortDigest } from "../lib/format";
import type { ControlPlaneSnapshot, Game, Operation, ServerState, Wipe, World, WorldTab as Tab } from "../model";
import { routeHash } from "../routing";
import { playersOnline, sessionReason } from "../session";
import type { SharedHostSession } from "../session";
import { Pending, pendingFor, SessionAction, WorldActionKind } from "../shell/actions";
import { useMediaQuery } from "../shell/hooks";
import { ConnectionAddress, releaseSummary, sessionActionForWorld, sessionControlAvailability, SharedHostNotice } from "./WorldsScreen";


type WorldScreenProps = Readonly<{
  game: Game;
  world: World;
  snapshot: ControlPlaneSnapshot | null;
  serverState: ServerState;
  sharedSession: SharedHostSession;
  granted: ReadonlySet<string>;
  pending: Pending | null;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onRefresh: () => void;
  onSessionAction: (game: Game, world: World, action: SessionAction) => void;
  onWorldAction: (game: Game, world: World, action: WorldActionKind, backup?: { key: string; name: string }) => void;
  onInvite: (game: Game, world: World) => void;
  onDownloadPack: (game: Game, world: World) => void;
}>;

type WorldMenuOptions = Readonly<{
  game: Game;
  world: World;
  granted: ReadonlySet<string>;
  busy: boolean;
  canManage: boolean;
  preset: Game["presets"][number] | undefined;
  onWorldAction: WorldScreenProps["onWorldAction"];
  onDownloadPack: WorldScreenProps["onDownloadPack"];
}>;

function buildWorldMenu({ game, world, granted, busy, canManage, preset, onWorldAction, onDownloadPack }: WorldMenuOptions): (MenuItem | "separator")[] {
  const menu: (MenuItem | "separator")[] = [];
  if (granted.has("connection.read")) menu.push({ id: "pack", label: "Download client pack", icon: "download", disabled: !world.release.activeRelease || busy, title: world.release.activeRelease ? `Pack for release ${world.release.activeRelease}` : "Available once a release is active", onSelect: () => onDownloadPack(game, world) });
  if (!canManage || !world.worldLifecycleAvailable) return menu;

  if (menu.length > 0) menu.push("separator");
  if (world.materialization === "existing") {
    menu.push({ id: "wipe", label: "Start a new wipe", detail: preset?.latestRelease ? `From ${preset.displayName} ${preset.latestRelease}` : "Needs a built release", icon: "history", disabled: busy || !preset?.latestRelease, onSelect: () => onWorldAction(game, world, "wipe") });
    menu.push({ id: "archive", label: "Archive this world", detail: "Stops, backs up, hides from session control", icon: "archive", disabled: busy, onSelect: () => onWorldAction(game, world, "archive") });
  }
  if (world.materialization === "archived") menu.push({ id: "purge", label: "Delete permanently", detail: "Registry, pointer and every backup", icon: "delete_forever", danger: true, disabled: busy, onSelect: () => onWorldAction(game, world, "purge") });
  return menu;
}

function buildWorldTabs(world: World, canReadReleases: boolean): { id: Tab; label: string; count?: number }[] {
  const tabs: { id: Tab; label: string; count?: number }[] = [{ id: "details", label: "Details" }];
  if (world.worldLifecycleAvailable) tabs.push({ id: "wipes", label: "Wipes", count: world.wipes.length });
  tabs.push({ id: "backups", label: "Backups" });
  if (canReadReleases) tabs.push({ id: "releases", label: "Releases" });
  return tabs;
}

function buildSessionDetails(game: Game, world: World, sharedSession: SharedHostSession, snapshot: ControlPlaneSnapshot | null, serverState: ServerState): DetailItem[] {
  const host = snapshot?.hosts[0];
  const session = sessionStatus(serverState);
  const hostLocation = host?.availabilityZone ? ` in ${host.availabilityZone}` : "";
  const reason = sessionReason(sharedSession, game, world);
  const players = playersOnline(game);
  const idleAt = game.lifecycle?.idle?.lastObservedAtEpochSeconds ?? null;
  return [
    // What the shared host is doing, and on whose behalf, reads as one thought
    // under the status. It needs no label of its own: a row called "Why" was
    // asking the reader a question instead of answering one.
    {
      label: "Session",
      value: <Status kind={session.kind} label={session.label} />,
      hint: <span className={reason.attention ? "session-reason-attention" : undefined}>{reason.text}</span>,
      explain: `${game.displayName} runs one session at a time on the shared host. ${reason.detail}`,
    },
    { label: "Compute host", value: host ? <Status kind={hostStatus(host.state).kind} label={`${host.name} · ${hostStatus(host.state).label.toLowerCase()}`} /> : <Ghost>No host available</Ghost>, hint: host?.instanceType ? `${host.instanceType}${hostLocation}` : undefined },
    // The same fact the Worlds page shows for the host: a reader who came from
    // there must not lose it on the way in.
    ...(host ? [{ label: "Launched", value: host.launchedAt ? <Timestamp value={host.launchedAt} /> : <Ghost>Not running</Ghost> }] : []),
    // Only meaningful while a watchdog is probing a ready session, which is
    // exactly when somebody is asking.
    ...(players === null ? [] : [{ label: "Players online", value: <strong className="num">{players}</strong>, hint: idleAt === null ? undefined : <>Counted <Timestamp value={idleAt} /></> }]),
    { label: "Last observed", value: <Timestamp value={snapshot?.observedAt} /> },
  ];
}

function buildWorldDetails(world: World, preset: Game["presets"][number] | undefined, currentWipe: Wipe | undefined, serverState: ServerState): DetailItem[] {
  const hasRelease = Boolean(world.release.activeRelease || world.release.desiredRelease);
  const release = hasRelease
    ? <span className="pair"><span>Active <strong>{world.release.activeRelease ?? "none"}</strong></span><Icon name="chevron_right" size={16} /><span>Desired <strong>{world.release.desiredRelease ?? "none"}</strong></span></span>
    : <Ghost>{releaseSummary(world)}</Ghost>;
  const emptyWipeLabel = world.worldLifecycleAvailable ? "No wipes yet" : "Not tracked";
  const currentWipeValue = currentWipe ? <span>#{currentWipe.number}</span> : <Ghost>{emptyWipeLabel}</Ghost>;
  return [
    { label: "World ID", value: world.id, mono: true, copy: world.id },
    { label: "Availability", value: <Status kind={worldStatus(world).kind} label={worldStatus(world).label} />, hint: world.worldLifecycleAvailable ? undefined : "Legacy world without wipe management" },
    { label: "Preset", value: preset ? <span>{preset.displayName}</span> : <span>{world.profileId}</span>, hint: world.preset ? <span className="mono">{repositoryName(world.preset.repository)} @ {shortCommit(world.preset.commit)}</span> : "Not built from a Git preset" },
    { label: "Release", value: release, explain: "The release this world runs, next to the one it is asked to run." },
    { label: "Current wipe", value: currentWipeValue, explain: "One wipe is one generation of this world. A new one keeps every backup of the old one.", hint: currentWipe ? `Opened ${formatDate(currentWipe.createdAt)} · release ${currentWipe.originRelease}` : undefined },
    { label: "Address", value: world.connectionAddress ? <ConnectionAddress address={world.connectionAddress} connectivity={world.connectivity} /> : <Ghost>{missingAddressLabel(world, serverState)}</Ghost>, copy: world.connectionAddress ?? undefined },
  ];
}

function missingAddressLabel(world: World, serverState: ServerState): string {
  if (world.materialization !== "existing") return "No address";
  return serverState === "running" ? "No address yet" : "Assigned while online";
}

export function WorldScreen({ game, world, snapshot, serverState, sharedSession, granted, pending, tab, onTabChange, onRefresh, onSessionAction, onWorldAction, onInvite, onDownloadPack }: WorldScreenProps) {
  const [wipeFilter, setWipeFilter] = useState<string | null>(null);
  useEffect(() => { setWipeFilter(null); }, [world.id]);
  const setTab = onTabChange;

  const rowPending = pendingFor(pending, world.id);
  const busy = rowPending !== null;
  const controlBusy = pending?.kind === "session" || pending?.kind === "lifecycle";
  const action: SessionAction = sessionActionForWorld(world, game, sharedSession);
  const permitted = granted.has(action === "start" ? "session.start" : "session.stop");
  const sessionControl = sessionControlAvailability(world, game, sharedSession, permitted, controlBusy || busy);
  const canManage = granted.has("world.manage");
  const preset = game.presets.find((item) => item.id === (world.preset?.id ?? world.profileId));
  const currentWipe = world.wipes.find((wipe) => wipe.state === "current") ?? world.wipes.at(-1);
  const availability = worldStatus(world);
  const operations = snapshot?.operations ?? [];
  const menu = buildWorldMenu({ game, world, granted, busy, canManage, preset, onWorldAction, onDownloadPack });
  const tabs = buildWorldTabs(world, granted.has("release.read"));
  const sessionDetails = buildSessionDetails(game, world, sharedSession, snapshot, serverState);
  const worldDetails = buildWorldDetails(world, preset, currentWipe, serverState);

  const operationColumns: Column<Operation>[] = [
    { id: "operation", label: "Operation", render: (operation) => <strong>{operationLabel(operation.type)}</strong> },
    { id: "execution", label: "Execution", truncate: true, render: (operation) => <Ellipsis mono tail={12} value={operation.id} /> },
    { id: "started", label: "Started", width: "140px", render: (operation) => <span className="num">{formatTime(operation.startedAt)}</span> },
    { id: "status", label: "Status", width: "140px", render: () => <Status kind="progress" label="Running" /> },
  ];

  return (
    <div className="page">
      <PageHeader
        actions={<WorldHeaderActions action={action} canInvite={granted.has("invitation.send")} game={game} onInvite={onInvite} onRefresh={onRefresh} onSessionAction={onSessionAction} refreshing={pending?.kind === "refresh"} rowPending={rowPending} sessionControl={sessionControl} world={world} />}
        overflow={<WorldOverflow canInvite={granted.has("invitation.send")} game={game} menu={menu} onInvite={onInvite} onRefresh={onRefresh} refreshing={pending?.kind === "refresh"} world={world} />}
        breadcrumb={[{ label: "Worlds", href: routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: null }) }]}
        status={<Status kind={availability.kind} label={availability.label} />}
        title={world.displayName}
      />
      <WorldNotices rowPending={rowPending} world={world} />
      <SharedHostNotice busy={controlBusy} session={sharedSession} />

      <div className="world-tabs">
        <Tabs label="World sections" onChange={setTab} options={tabs} value={tab} />
        <WorldTabContent busy={busy} game={game} granted={granted} onDownloadPack={onDownloadPack} onWorldAction={onWorldAction} operationColumns={operationColumns} operations={operations} sessionDetails={sessionDetails} setTab={setTab} setWipeFilter={setWipeFilter} tab={tab} wipeFilter={wipeFilter} world={world} worldDetails={worldDetails} />
      </div>
    </div>
  );
}

function WorldHeaderActions({ action, canInvite, game, onInvite, onRefresh, onSessionAction, refreshing, rowPending, sessionControl, world }: Readonly<{
  action: SessionAction;
  canInvite: boolean;
  game: Game;
  onInvite: WorldScreenProps["onInvite"];
  onRefresh: () => void;
  onSessionAction: WorldScreenProps["onSessionAction"];
  refreshing: boolean;
  rowPending: Pending | null;
  sessionControl: ReturnType<typeof sessionControlAvailability>;
  world: World;
}>) {
  const actionLabel = action === "stop" ? "Stop" : "Start";
  // A phone has room for one decision. Refresh and Invite are worth reaching,
  // not worth three wrapped rows above the page, so they move into the overflow.
  const narrow = useMediaQuery("(max-width: 599px)");
  return <>
    {!narrow && <Button icon="refresh" loading={refreshing} onClick={onRefresh} variant="outlined">Refresh</Button>}
    {!narrow && canInvite && <Button icon="send" onClick={() => onInvite(game, world)} variant="outlined">Invite players</Button>}
    {/* A disabled button cannot be focused and answers no hover on a touch
        screen, so the reason it is disabled needs a reachable home. Some of
        these reasons are also in the notice above; the per-world ones are not
        anywhere else at all. */}
    <SessionControl action={action} actionLabel={actionLabel} game={game} onSessionAction={onSessionAction} rowPending={rowPending} sessionControl={sessionControl} world={world} />
  </>;
}

// The overflow lives in the title row, beside the name and the state.
function WorldOverflow({ game, world, menu, canInvite, refreshing, onInvite, onRefresh }: Readonly<{
  game: Game;
  world: World;
  menu: readonly (MenuItem | "separator")[];
  canInvite: boolean;
  refreshing: boolean;
  onInvite: WorldScreenProps["onInvite"];
  onRefresh: () => void;
}>) {
  const narrow = useMediaQuery("(max-width: 599px)");
  const secondary: (MenuItem | "separator")[] = [
    { id: "refresh", label: "Refresh", icon: "refresh", disabled: refreshing, onSelect: onRefresh },
    ...(canInvite ? [{ id: "invite", label: "Invite players", icon: "send" as const, onSelect: () => onInvite(game, world) }] : []),
  ];
  const items = narrow ? [...secondary, ...(menu.length > 0 ? ["separator" as const, ...menu] : [])] : menu;
  if (items.length === 0) return null;
  return <Menu align="end" items={items} label={`More actions for ${world.displayName}`} />;
}

function SessionControl({ action, actionLabel, game, onSessionAction, rowPending, sessionControl, world }: Readonly<{
  action: SessionAction;
  actionLabel: string;
  game: Game;
  onSessionAction: WorldScreenProps["onSessionAction"];
  rowPending: Pending | null;
  sessionControl: ReturnType<typeof sessionControlAvailability>;
  world: World;
}>) {
  const button = (
    <Button
      aria-label={`${actionLabel} ${world.displayName}. ${sessionControl.hint}`}
      disabled={sessionControl.disabled}
      icon={action === "stop" ? "stop" : "play_arrow"}
      loading={rowPending?.kind === "session"}
      onClick={() => onSessionAction(game, world, action)}
      title={sessionControl.disabled ? undefined : sessionControl.hint}
      variant={action === "stop" ? "danger" : "filled"}
    >
      {actionLabel}
    </Button>
  );
  return sessionControl.disabled ? <Tooltip text={sessionControl.hint}>{button}</Tooltip> : button;
}

function WorldNotices({ rowPending, world }: Readonly<{ rowPending: Pending | null; world: World }>) {
  const operation = pendingWorldOperationLabel(rowPending);
  return <>
    {world.materialization === "archived" && <Banner description="Restore one of its backups to open a new wipe, or delete it permanently from the actions menu." title="This world is archived" tone="warning" />}
    {operation && <Banner description={`Spawnpoint is requesting ${operation}. The operation appears in the table below once accepted.`} title="World operation in progress" tone="info" />}
  </>;
}

function pendingWorldOperationLabel(pending: Pending | null): string | null {
  if (pending?.kind !== "lifecycle") return null;
  if (pending.action === "wipe") return "a new wipe";
  return pending.action;
}

function WorldTabContent({ busy, game, granted, onDownloadPack, onWorldAction, operationColumns, operations, sessionDetails, setTab, setWipeFilter, tab, wipeFilter, world, worldDetails }: Readonly<{
  busy: boolean;
  game: Game;
  granted: ReadonlySet<string>;
  onDownloadPack: WorldScreenProps["onDownloadPack"];
  onWorldAction: WorldScreenProps["onWorldAction"];
  operationColumns: readonly Column<Operation>[];
  operations: readonly Operation[];
  sessionDetails: readonly DetailItem[];
  setTab: (tab: Tab) => void;
  setWipeFilter: (wipeId: string | null) => void;
  tab: Tab;
  wipeFilter: string | null;
  world: World;
  worldDetails: readonly DetailItem[];
}>) {
  return <>
    {tab === "details" && <>
      <Card><div className="details-columns"><DetailsGroup items={sessionDetails} level={2} title="Session" /><DetailsGroup items={worldDetails} level={2} title="World" /></div></Card>
      <Card flush title="Operations">
        <DataTable columns={operationColumns} empty={<EmptyState description="Completed executions will be listed after the operations API exposes history. Spawnpoint shows only what it observes." icon="sync" title="No operation in progress" />} label="Running operations" rowKey={(operation) => `${operation.type}-${operation.id}`} rows={operations} />
      </Card>
    </>}
    {tab === "wipes" && <WipesTab onShowBackups={(wipe) => { setWipeFilter(wipe.id); setTab("backups"); }} world={world} />}
    {tab === "backups" && <BackupsTab busy={busy} canRead={granted.has("backup.read")} canRestore={granted.has("backup.restore")} filter={wipeFilter} gameId={game.id} onFilter={setWipeFilter} onRestore={(entry) => onWorldAction(game, world, "restore", { key: entry.key, name: entry.archiveName })} settled={`${world.wipes.length}:${operations.length}`} world={world} />}
    {tab === "releases" && <ReleasesTab busy={busy} canDownload={granted.has("connection.read")} onDownload={() => onDownloadPack(game, world)} world={world} />}
  </>;
}

function WipesTab({ world, onShowBackups }: Readonly<{ world: World; onShowBackups: (wipe: Wipe) => void }>) {
  const columns: Column<Wipe>[] = [
    { id: "wipe", label: "Wipe", width: "120px", render: (wipe) => <strong className="num">#{wipe.number}</strong> },
    { id: "status", label: "Status", width: "140px", render: (wipe) => wipe.state === "current" ? <Chip tone="primary">Current</Chip> : <Chip tone="tonal">Closed</Chip> },
    { id: "release", label: "Started on release", width: "140px", render: (wipe) => <code>{wipe.originRelease}</code> },
    { id: "opened", label: "Opened", render: (wipe) => <Timestamp value={wipe.createdAt} /> },
    { id: "closed", label: "Closed", render: (wipe) => wipe.closedAt ? <Timestamp value={wipe.closedAt} /> : <Ghost>Open</Ghost> },
    { id: "actions", label: "Actions", actions: true, render: (wipe) => <Button onClick={() => onShowBackups(wipe)} size="small" variant="text">Backups</Button> },
  ];
  return (
    <Card flush title="Wipes">
      <DataTable columns={columns} empty={<EmptyState description="The first start opens wipe #1." icon="history" title="No wipes yet" />} label={`Wipes of ${world.displayName}`} rowKey={(wipe) => wipe.id} rows={[...world.wipes].reverse()} />
    </Card>
  );
}

function BackupsTab({ world, gameId, canRead, canRestore, busy, filter, onFilter, onRestore, settled }: Readonly<{
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
}>) {
  const [inventory, setInventory] = useState<BackupInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<ApiFailureKind>("failed");
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
      .catch((cause: unknown) => {
        if (!current) return;
        setError(cause instanceof Error ? cause.message : "The backup inventory is unavailable.");
        setErrorKind(failureKind(cause));
      });
    return () => { current = false; };
  }, [canRead, gameId, world.id, revision, settled]);

  const entries = useMemo(() => (inventory?.entries ?? []).filter((entry) => filter === null || entry.generationId === filter), [inventory, filter]);
  const wipeNumber = (generationId: string | null) => world.wipes.find((wipe) => wipe.id === generationId)?.number;
  const columns: Column<BackupInventory["entries"][number]>[] = [
    // The timestamp is the only part that tells two archives of one world apart,
    // so it is the part that survives a narrow column.
    { id: "archive", label: "Archive", truncate: true, width: "45%", render: (entry) => <span className="copy-value"><Ellipsis mono tail={22} value={entry.archiveName} /><CopyButton label={`Copy the archive name ${entry.archiveName}`} value={entry.archiveName} /></span> },
    { id: "wipe", label: "Wipe", width: "100px", render: (entry) => { const number = wipeNumber(entry.generationId); return number !== undefined ? <span className="num">#{number}</span> : <Ghost>Legacy</Ghost>; } },
    { id: "stored", label: "Stored", render: (entry) => <Timestamp value={entry.storedAt} /> },
    { id: "size", label: "Size", width: "110px", align: "num", render: (entry) => formatBytes(entry.sizeBytes) },
    { id: "checksum", label: "SHA-256", secondary: true, width: "210px", render: (entry) => <span className="copy-value"><code title={entry.checksum}>{shortDigest(entry.checksum)}</code><CopyButton label="Copy the full checksum" value={entry.checksum} /></span> },
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
    <Card description="Restoring one opens a new wipe. Nothing here is overwritten." flush title="Backups">
      {world.wipes.length > 0 && (
        <div className="filter-bar">
          <Icon name="filter_list" size={20} />
          <div aria-label="Filter backups by wipe" className="chip-row" role="group">
            <ChoiceChip onClick={() => onFilter(null)} pressed={filter === null}>All wipes</ChoiceChip>
            {[...world.wipes].reverse().map((wipe) => <ChoiceChip key={wipe.id} onClick={() => onFilter(wipe.id)} pressed={filter === wipe.id}>Wipe #{wipe.number}</ChoiceChip>)}
          </div>
        </div>
      )}
      {error !== null && errorKind === "unavailable" && <NotConnected description="Verified archives appear here once the backup inventory is reachable." title="The backup inventory is not connected yet" />}
      {error !== null && errorKind !== "unavailable" && <div style={{ padding: 16 }}><Banner actions={<Button onClick={() => setRevision((value) => value + 1)} variant="text">Try again</Button>} description={error} title="The inventory is unavailable" tone="error" /></div>}
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
    { id: "release", label: "Release", width: "140px", render: (row) => <code>{row.name}</code> },
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
    <Card description="Pack links are presigned for an hour." flush title="Release pointer">
      <DataTable columns={columns} empty={<EmptyState description={world.release.state === "unconfigured" ? "This world has no release pointer yet." : "Release data is unavailable."} icon="inventory" title="No release" />} label={`Release pointer of ${world.displayName}`} rowKey={(row) => row.name} rows={rows} />
    </Card>
  );
}

function operationLabel(type: Operation["type"]): string {
  return type === "start" ? "Starting session" : type === "stop" ? "Stopping session" : type === "world" ? "Updating world" : "Promoting release";
}
