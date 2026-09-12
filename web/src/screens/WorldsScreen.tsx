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
import { Pending, pendingFor, SessionAction, WorldActionKind } from "../shell/actions";

export type WorldsScreenProps = {
  game: Game | undefined;
  snapshot: ControlPlaneSnapshot | null;
  status: "loading" | "ready" | "error";
  error: string;
  serverState: ServerState;
  granted: ReadonlySet<string>;
  pending: Pending | null;
  onRefresh: () => void;
  onSessionAction: (game: Game, world: World, action: SessionAction) => void;
  onWorldAction: (game: Game, world: World, action: Exclude<WorldActionKind, "restore">) => void;
  onInvite: (game: Game, world: World) => void;
  onDownloadPack: (game: Game, world: World) => void;
  onCreateSave: (game: Game) => void;
};

export function WorldsScreen({ game, snapshot, status, error, serverState, granted, pending, onRefresh, onSessionAction, onWorldAction, onInvite, onDownloadPack, onCreateSave }: WorldsScreenProps) {
  const loading = status === "loading";
  const host = snapshot?.hosts[0];
  const session = sessionStatus(serverState);
  const transitioning = serverState === "starting" || serverState === "stopping";
  const canManage = granted.has("world.manage");
  const readyPreset = game?.presets.some((preset) => preset.buildStatus === "ready") ?? false;

  if (!loading && !game) {
    return (
      <div className="page">
        <PageHeader title="Worlds" />
        {status === "error" && <Banner actions={<Button onClick={onRefresh} variant="text">Try again</Button>} description={error} title="Current state could not be loaded" tone="error" />}
        <Card flush>
          <EmptyState description={status === "error" ? "Spawnpoint could not read games, worlds and the compute host." : "The control plane lists no games yet. Games and their presets are declared in Git."} icon="public" title="No games to show" />
        </Card>
      </div>
    );
  }

  const columns: Column<World>[] = [
    { id: "status", label: "Status", width: "130px", render: (world) => { const state = worldStatus(world); return <Status kind={state.kind} label={state.label} />; } },
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
      render: (world) => game ? <RowActions game={game} granted={granted} onDownloadPack={onDownloadPack} onInvite={onInvite} onSessionAction={onSessionAction} onWorldAction={onWorldAction} pending={pendingFor(pending, world.id)} serverState={serverState} transitioning={transitioning} world={world} /> : null,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        actions={<>
          <Button icon="refresh" loading={pending?.kind === "refresh"} onClick={onRefresh} variant="outlined">Refresh</Button>
          {game && canManage && readyPreset && <Button icon="add" onClick={() => onCreateSave(game)} variant="filled">Create save</Button>}
        </>}
        description={game ? `${plural(game.worlds.length, "save")} across ${plural(game.presets.length, "preset")}. One shared compute host runs one session at a time.` : undefined}
        title="Worlds"
      />
      {status === "error" && <Banner actions={<Button onClick={onRefresh} variant="text">Try again</Button>} description={error} title="Current state could not be loaded" tone="error" />}

      <Card as="section" className="session-card-wrap" flush>
        <div aria-busy={loading} className="session-card">
          <div className="session-state">
            {loading ? <Skeleton height={28} width="60%" /> : <Status kind={session.kind} label={`${game?.displayName ?? "Session"} ${session.label.toLowerCase()}`} size="large" />}
            <div className="pairs">
              {loading ? <><Skeleton width="70%" /><Skeleton width="50%" /></> : <>
                <span>Desired <strong>{game?.lifecycle?.desiredState ?? "unknown"}</strong> <Icon name="chevron_right" size={16} /> observed <strong>{game?.lifecycle?.observedState ?? "unknown"}</strong></span>
                <span>Last observed <strong>{formatDateTime(snapshot?.observedAt)}</strong></span>
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

function Fact({ label, children, loading, mono = false }: { label: string; children: ReactNode; loading: boolean; mono?: boolean }) {
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

export function sessionControlHint(world: World, action: SessionAction, permitted: boolean, transitioning: boolean): string {
  if (!world.sessionControlAvailable) {
    if (world.materialization === "archived") return "This world is archived. Restore a backup to open a new wipe.";
    if (world.materialization === "not_created") return "This preset needs a successful release build before its first start.";
    return "This world is not connected to a session workflow yet.";
  }
  if (!permitted) return `Your role cannot ${action} sessions.`;
  if (transitioning) return "A control-plane operation is already in progress.";
  return action === "start" ? "Start a billed session on the shared host" : "Save, back up and stop the session";
}

export function RowActions({ game, world, serverState, granted, pending, transitioning, onSessionAction, onWorldAction, onInvite, onDownloadPack, compact = true }: {
  game: Game;
  world: World;
  serverState: ServerState;
  granted: ReadonlySet<string>;
  pending: Pending | null;
  transitioning: boolean;
  onSessionAction: (game: Game, world: World, action: SessionAction) => void;
  onWorldAction: (game: Game, world: World, action: Exclude<WorldActionKind, "restore">) => void;
  onInvite: (game: Game, world: World) => void;
  onDownloadPack: (game: Game, world: World) => void;
  compact?: boolean;
}) {
  const action: SessionAction = serverState === "running" ? "stop" : "start";
  const permitted = granted.has(action === "start" ? "session.start" : "session.stop");
  const busy = pending !== null;
  const disabled = !world.sessionControlAvailable || !permitted || transitioning || busy;
  const hint = sessionControlHint(world, action, permitted, transitioning);
  const canManage = granted.has("world.manage");
  const items: (MenuItem | "separator")[] = [
    { id: "details", label: "View details", icon: "chevron_right", onSelect: () => { window.location.hash = routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: world.id }); } },
  ];
  if (granted.has("invitation.send")) items.push({ id: "invite", label: "Invite players", icon: "send", onSelect: () => onInvite(game, world) });
  if (granted.has("connection.read")) items.push({ id: "pack", label: "Download client pack", icon: "download", disabled: !world.release.activeRelease || busy, title: world.release.activeRelease ? `Pack for release ${world.release.activeRelease}` : "Available once a release is active", onSelect: () => onDownloadPack(game, world) });
  if (canManage && world.worldLifecycleAvailable) {
    items.push("separator");
    if (world.materialization === "existing") {
      items.push({ id: "wipe", label: "Start a new wipe", icon: "history", disabled: busy || !game.presets.some((preset) => preset.id === (world.preset?.id ?? world.profileId) && preset.latestRelease), onSelect: () => onWorldAction(game, world, "wipe") });
      items.push({ id: "archive", label: "Archive", icon: "archive", disabled: busy, onSelect: () => onWorldAction(game, world, "archive") });
    }
    if (world.materialization === "archived") items.push({ id: "purge", label: "Delete permanently", icon: "delete_forever", danger: true, disabled: busy, onSelect: () => onWorldAction(game, world, "purge") });
  }
  return (
    <>
      <Button
        disabled={disabled}
        icon={action === "stop" ? "stop" : "play_arrow"}
        loading={pending?.kind === "session"}
        onClick={() => onSessionAction(game, world, action)}
        size={compact ? "small" : "medium"}
        title={hint}
        variant={action === "stop" ? "danger-text" : compact ? "text" : "filled"}
      >
        {action === "stop" ? "Stop" : "Start"}
      </Button>
      <Menu items={items} label={`More actions for ${world.displayName}`} size={compact ? "small" : "medium"} />
    </>
  );
}
