import type { ReactNode } from "react";

import { Button } from "../components/ui/Button";
import { Column, DataTable } from "../components/ui/DataTable";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Skeleton } from "../components/ui/Skeleton";
import { hostStatus, sessionStatus, Status, worldStatus } from "../components/ui/Status";
import { Banner, Card, CopyButton, EmptyState, Ghost, PageHeader } from "../components/ui/Surfaces";
import { Icon } from "../icons";
import { formatDate, formatDateTime, plural } from "../lib/format";
import type { ControlPlaneSnapshot, Game, ServerState, World } from "../model";
import { routeHash } from "../routing";
import { sharedSessionOwnerLabel, worldOwnsSharedSession } from "../session";
import type { SharedHostSession } from "../session";
import { Pending, pendingFor, SessionAction, WorldActionKind } from "../shell/actions";

export type WorldsScreenProps = Readonly<{
  game: Game | undefined;
  snapshot: ControlPlaneSnapshot | null;
  status: "loading" | "ready" | "error";
  error: string;
  serverState: ServerState;
  sharedSession: SharedHostSession;
  granted: ReadonlySet<string>;
  pending: Pending | null;
  onRefresh: () => void;
  onSessionAction: (game: Game, world: World, action: SessionAction) => void;
  onWorldAction: (game: Game, world: World, action: Exclude<WorldActionKind, "restore">) => void;
  onInvite: (game: Game, world: World) => void;
  onDownloadPack: (game: Game, world: World) => void;
  onCreateSave: (game: Game) => void;
}>;

export function WorldsScreen({ game, snapshot, status, error, serverState, sharedSession, granted, pending, onRefresh, onSessionAction, onWorldAction, onInvite, onDownloadPack, onCreateSave }: WorldsScreenProps) {
  const loading = status === "loading";
  const host = snapshot?.hosts[0];
  const session = sessionStatus(serverState);
  const controlBusy = pending?.kind === "session" || pending?.kind === "lifecycle";
  const canManage = granted.has("world.manage");
  const readyPreset = game?.presets.some((preset) => preset.buildStatus === "ready") ?? false;

  if (!loading && !game) {
    return <WorldsUnavailable error={error} failed={status === "error"} onRefresh={onRefresh} />;
  }

  const columns: Column<World>[] = [
    { id: "status", label: "Status", width: "130px", render: (world) => { const state = worldOwnsSharedSession(sharedSession, game!, world) && sharedSession.state === "running" ? sessionStatus("running") : worldStatus(world); return <Status kind={state.kind} label={state.label} />; } },
    {
      id: "name",
      label: "Name",
      render: (world) => (
        <span className="world-name">
          <a className="row-link" href={routeHash({ page: "worlds", accessTab: "users", gameId: game?.id ?? null, worldId: world.id })}>{world.displayName}</a>
          <small>{world.id}</small>
        </span>
      ),
    },
    {
      id: "release",
      label: "Preset and release",
      render: (world) => {
        const preset = game?.presets.find((item) => item.id === world.preset?.id || item.id === world.profileId);
        return (
          <span>
            <strong>{preset?.displayName ?? world.profileId}</strong>
            <small>{releaseSummary(world)}</small>
          </span>
        );
      },
    },
    {
      id: "wipe",
      label: "Wipe",
      width: "170px",
      render: (world) => {
        const wipe = world.wipes.find((item) => item.state === "current") ?? world.wipes.at(-1);
        return wipe ? <span><strong className="num">#{wipe.number}</strong><small>Opened {formatDate(wipe.createdAt)}</small></span> : <Ghost>{world.worldLifecycleAvailable ? "No wipes yet" : "Legacy world"}</Ghost>;
      },
    },
    {
      id: "address",
      label: "Address",
      render: (world) => world.connectionAddress
        ? <span><span className="copy-value"><code>{world.connectionAddress}</code><CopyButton label={`Copy the address of ${world.displayName}`} value={world.connectionAddress} /></span><small>{world.connectivity === "zerotier" ? "ZeroTier network" : "Public address"}</small></span>
        : <Ghost>{world.materialization !== "existing" ? "No address" : serverState === "running" ? "No address yet" : "Assigned while online"}</Ghost>,
    },
    {
      id: "actions",
      label: "Actions",
      actions: true,
      render: (world) => game ? <RowActions controlBusy={controlBusy} game={game} granted={granted} onDownloadPack={onDownloadPack} onInvite={onInvite} onSessionAction={onSessionAction} onWorldAction={onWorldAction} pending={pendingFor(pending, world.id)} sharedSession={sharedSession} world={world} /> : null,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        actions={<WorldsHeaderActions canCreate={canManage && readyPreset} game={game} loading={pending?.kind === "refresh"} onCreateSave={onCreateSave} onRefresh={onRefresh} />}
        description={game ? `${plural(game.worlds.length, "save")} across ${plural(game.presets.length, "preset")}. One shared compute host runs one session at a time.` : undefined}
        title="Worlds"
      />
      {status === "error" && <Banner actions={<Button onClick={onRefresh} variant="text">Try again</Button>} description={error} title="Current state could not be loaded" tone="error" />}
      <SharedHostNotice busy={controlBusy} session={sharedSession} />

      <SessionOverview game={game} host={host} loading={loading} observedAt={snapshot?.observedAt} session={session} />

      <Card flush title={game ? `Worlds of ${game.displayName}` : "Worlds"}>
        <DataTable
          columns={columns}
          empty={<EmptyState description={canManage && readyPreset ? "Create the first save from a ready preset." : "Saves appear here once a preset has a ready release and a save is created."} icon="public" title="No saves in this game" />}
          label={game ? `Worlds of ${game.displayName}` : "Worlds"}
          loading={loading}
          loadingRows={3}
          rowKey={(world) => world.id}
          rows={game?.worlds ?? []}
        />
      </Card>
    </div>
  );
}

function WorldsUnavailable({ error, failed, onRefresh }: Readonly<{ error: string; failed: boolean; onRefresh: () => void }>) {
  const description = failed
    ? "Spawnpoint could not read games, worlds and the compute host."
    : "The control plane lists no games yet. Games and their presets are declared in Git.";
  return (
    <div className="page">
      <PageHeader title="Worlds" />
      {failed && <Banner actions={<Button onClick={onRefresh} variant="text">Try again</Button>} description={error} title="Current state could not be loaded" tone="error" />}
      <Card flush><EmptyState description={description} icon="public" title="No games to show" /></Card>
    </div>
  );
}

function WorldsHeaderActions({ canCreate, game, loading, onCreateSave, onRefresh }: Readonly<{
  canCreate: boolean;
  game: Game | undefined;
  loading: boolean;
  onCreateSave: (game: Game) => void;
  onRefresh: () => void;
}>) {
  return <>
    <Button icon="refresh" loading={loading} onClick={onRefresh} variant="outlined">Refresh</Button>
    {canCreate && game && <Button icon="add" onClick={() => onCreateSave(game)} variant="filled">Create save</Button>}
  </>;
}

function SessionOverview({ game, host, loading, observedAt, session }: Readonly<{
  game: Game | undefined;
  host: ControlPlaneSnapshot["hosts"][number] | undefined;
  loading: boolean;
  observedAt: string | undefined;
  session: ReturnType<typeof sessionStatus>;
}>) {
  return (
    <Card as="section" className="session-card-wrap" flush>
      <div aria-busy={loading} className="session-card">
        <div className="session-state">
          {loading ? <Skeleton height={28} width="60%" /> : <Status kind={session.kind} label={`${game?.displayName ?? "Session"} ${session.label.toLowerCase()}`} size="large" />}
          <div className="pairs">
            {loading ? <><Skeleton width="70%" /><Skeleton width="50%" /></> : <>
              <span>Desired <strong>{game?.lifecycle?.desiredState ?? "unknown"}</strong> <Icon name="chevron_right" size={16} /> observed <strong>{game?.lifecycle?.observedState ?? "unknown"}</strong></span>
              <span>Last observed <strong>{formatDateTime(observedAt)}</strong></span>
            </>}
          </div>
        </div>
        <dl className="session-facts">
          <Fact label="Compute host" loading={loading}>{host ? <Status kind={hostStatus(host.state).kind} label={`${host.name} · ${hostStatus(host.state).label.toLowerCase()}`} /> : <Ghost>No host available</Ghost>}</Fact>
          <Fact label="Instance type" loading={loading} mono>{host?.instanceType ?? <Ghost>Not reported</Ghost>}</Fact>
          <Fact label="Zone" loading={loading} mono>{host?.availabilityZone ?? <Ghost>Not reported</Ghost>}</Fact>
          <Fact label="Launched" loading={loading}>{host?.launchedAt ? formatDateTime(host.launchedAt) : <Ghost>Not running</Ghost>}</Fact>
        </dl>
      </div>
    </Card>
  );
}

function Fact({ label, children, loading, mono = false }: Readonly<{ label: string; children: ReactNode; loading: boolean; mono?: boolean }>) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{loading ? <Skeleton width="70%" /> : children}</dd>
    </div>
  );
}

export function releaseSummary(world: World): string {
  const { activeRelease, desiredRelease, state } = world.release;
  if (activeRelease && desiredRelease && activeRelease !== desiredRelease) return `Active ${activeRelease} · desired ${desiredRelease}`;
  if (activeRelease) return `Release ${activeRelease}`;
  if (world.materialization === "not_created") return world.preset?.buildStatus === "ready" ? `First start uses ${world.preset.latestRelease ?? "the latest release"}` : `Preset ${world.preset?.buildStatus ?? "unbuilt"}`;
  if (state === "unconfigured") return "No release selected";
  return "Release unavailable";
}

export function sessionControlAvailability(world: World, game: Game, sharedSession: SharedHostSession, permitted: boolean, controlBusy: boolean): { action: SessionAction; disabled: boolean; hint: string } {
  const action = sessionActionForWorld(world, game, sharedSession);
  if (!world.sessionControlAvailable) {
    if (world.materialization === "archived") return { action, disabled: true, hint: "This world is archived. Restore a backup to open a new wipe." };
    if (world.materialization === "not_created") return { action, disabled: true, hint: "This preset needs a successful release build before its first start." };
    return { action, disabled: true, hint: "This world is not connected to a session workflow yet." };
  }
  if (!permitted) return { action, disabled: true, hint: `Your role cannot ${action} sessions.` };
  if (controlBusy || sharedSession.operationRunning) return { action, disabled: true, hint: "A control-plane operation is already in progress." };
  if (sharedSession.state === "starting" || sharedSession.state === "stopping") return { action, disabled: true, hint: `The shared host is ${sharedSession.state}.` };
  if (sharedSession.state === "unknown") return { action, disabled: true, hint: "Spawnpoint cannot confirm that the shared host is free. Refresh before trying again." };
  if (action === "start" && sharedSession.state === "running") {
    const owner = sharedSessionOwnerLabel(sharedSession);
    return { action, disabled: true, hint: owner ? `${owner} is using the shared host. Stop that session first.` : "Another session is using the shared host. Stop it first." };
  }
  return { action, disabled: false, hint: action === "start" ? "Start a billed session on the shared host" : "Save, back up and stop this session" };
}

export function sessionActionForWorld(world: World, game: Game, sharedSession: SharedHostSession): SessionAction {
  return worldOwnsSharedSession(sharedSession, game, world) && sharedSession.state !== "stopped" ? "stop" : "start";
}

type RowActionItemsOptions = Readonly<{
  game: Game;
  world: World;
  granted: ReadonlySet<string>;
  busy: boolean;
  onWorldAction: (game: Game, world: World, action: Exclude<WorldActionKind, "restore">) => void;
  onInvite: (game: Game, world: World) => void;
  onDownloadPack: (game: Game, world: World) => void;
}>;

function rowActionItems({ game, world, granted, busy, onWorldAction, onInvite, onDownloadPack }: RowActionItemsOptions): (MenuItem | "separator")[] {
  const items: (MenuItem | "separator")[] = [
    { id: "details", label: "View details", icon: "chevron_right", onSelect: () => { window.location.hash = routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: world.id }); } },
  ];
  if (granted.has("invitation.send")) items.push({ id: "invite", label: "Invite players", icon: "send", onSelect: () => onInvite(game, world) });
  if (granted.has("connection.read")) items.push({ id: "pack", label: "Download client pack", icon: "download", disabled: !world.release.activeRelease || busy, title: world.release.activeRelease ? `Pack for release ${world.release.activeRelease}` : "Available once a release is active", onSelect: () => onDownloadPack(game, world) });
  if (!granted.has("world.manage") || !world.worldLifecycleAvailable) return items;

  items.push("separator");
  appendWorldLifecycleActions(items, game, world, busy, onWorldAction);
  return items;
}

function appendWorldLifecycleActions(items: (MenuItem | "separator")[], game: Game, world: World, busy: boolean, onWorldAction: RowActionItemsOptions["onWorldAction"]): void {
  if (world.materialization === "existing") {
    const presetId = world.preset?.id ?? world.profileId;
    const hasRelease = game.presets.some((preset) => preset.id === presetId && preset.latestRelease);
    items.push({ id: "wipe", label: "Start a new wipe", icon: "history", disabled: busy || !hasRelease, onSelect: () => onWorldAction(game, world, "wipe") });
    items.push({ id: "archive", label: "Archive", icon: "archive", disabled: busy, onSelect: () => onWorldAction(game, world, "archive") });
  }
  if (world.materialization === "archived") items.push({ id: "purge", label: "Delete permanently", icon: "delete_forever", danger: true, disabled: busy, onSelect: () => onWorldAction(game, world, "purge") });
}

export function RowActions({ game, world, sharedSession, granted, pending, controlBusy, onSessionAction, onWorldAction, onInvite, onDownloadPack, compact = true }: Readonly<{
  game: Game;
  world: World;
  sharedSession: SharedHostSession;
  granted: ReadonlySet<string>;
  pending: Pending | null;
  controlBusy: boolean;
  onSessionAction: (game: Game, world: World, action: SessionAction) => void;
  onWorldAction: (game: Game, world: World, action: Exclude<WorldActionKind, "restore">) => void;
  onInvite: (game: Game, world: World) => void;
  onDownloadPack: (game: Game, world: World) => void;
  compact?: boolean;
}>) {
  const action = sessionActionForWorld(world, game, sharedSession);
  const permitted = granted.has(action === "start" ? "session.start" : "session.stop");
  const busy = pending !== null;
  const availability = sessionControlAvailability(world, game, sharedSession, permitted, controlBusy || busy);
  const items = rowActionItems({ game, world, granted, busy, onWorldAction, onInvite, onDownloadPack });
  return (
    <>
      <Button
        aria-label={`${action === "stop" ? "Stop" : "Start"} ${world.displayName}. ${availability.hint}`}
        disabled={availability.disabled}
        icon={action === "stop" ? "stop" : "play_arrow"}
        loading={pending?.kind === "session"}
        onClick={() => onSessionAction(game, world, action)}
        size={compact ? "small" : "medium"}
        title={availability.hint}
        variant={action === "stop" ? "danger-text" : compact ? "text" : "filled"}
      >
        {action === "stop" ? "Stop" : "Start"}
      </Button>
      <Menu items={items} label={`More actions for ${world.displayName}`} size={compact ? "small" : "medium"} />
    </>
  );
}

export function SharedHostNotice({ session, busy }: Readonly<{ session: SharedHostSession; busy: boolean }>) {
  const owner = sharedSessionOwnerLabel(session);
  if (busy || session.operationRunning || session.state === "starting" || session.state === "stopping") {
    return <Banner description={owner ? `${owner} owns the current session. Session controls stay locked until the operation finishes.` : "Session controls stay locked until the current operation finishes."} title="Shared host operation in progress" tone="info" />;
  }
  if (session.state === "running") {
    return <Banner description={owner ? `${owner} is running. Stop that session before starting another world.` : "A session is running, but its world is not reported. Session starts stay locked for safety."} title="Shared host is occupied" tone="info" />;
  }
  if (session.state === "unknown") {
    return <Banner description="Spawnpoint cannot prove that the shared host is free. Refresh the control-plane state before starting a world." title="Shared host availability is unknown" tone="warning" />;
  }
  return null;
}
