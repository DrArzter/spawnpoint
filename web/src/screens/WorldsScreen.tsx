import type { ReactNode } from "react";

import { Button } from "../components/ui/Button";
import { Column, DataTable } from "../components/ui/DataTable";
import { Ellipsis } from "../components/ui/Ellipsis";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Skeleton } from "../components/ui/Skeleton";
import { Timestamp } from "../components/ui/Timestamp";
import { Tooltip } from "../components/ui/Tooltip";
import { hostStatus, sessionStatus, Status, worldStatus } from "../components/ui/Status";
import { Banner, Card, CopyButton, EmptyState, Ghost } from "../components/ui/Surfaces";
import { Icon } from "../icons";
import { formatDate, formatDateTime, plural } from "../lib/format";
import type { ControlPlaneSnapshot, Game, ServerState, World } from "../model";
import { routeHash } from "../routing";
import { playersOnline, sessionReason, sharedSessionOwnerLabel, worldOwnsSharedSession } from "../session";
import type { SessionReason, SharedHostSession } from "../session";
import { Pending, pendingFor, SessionAction, WorldActionKind } from "../shell/actions";

export type WorldsScreenProps = Readonly<{
  game: Game | undefined;
  snapshot: ControlPlaneSnapshot | null;
  status: "loading" | "ready" | "error";
  error: string;
  serverState: ServerState;
  sharedSession: SharedHostSession;
  fleet: boolean;
  granted: ReadonlySet<string>;
  pending: Pending | null;
  onRefresh: () => void;
  onWorldAction: (game: Game, world: World, action: Exclude<WorldActionKind, "restore">) => void;
  onInvite: (game: Game, world: World) => void;
  onDownloadPack: (game: Game, world: World) => void;
  onCreateWorld: (game: Game) => void;
}>;

export function WorldsScreen({ game, snapshot, status, error, serverState, sharedSession, fleet, granted, pending, onRefresh, onWorldAction, onInvite, onDownloadPack, onCreateWorld }: WorldsScreenProps) {
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
    { id: "status", label: "Status", width: "15%", render: (world) => { const active = fleet ? game?.lifecycle?.activeWorldId === world.id && game.lifecycle.observedState === "ready" : worldOwnsSharedSession(sharedSession, game!, world) && sharedSession.state === "running"; const state = active ? sessionStatus("running") : worldStatus(world); return <Status kind={state.kind} label={state.label} />; } },
    {
      id: "name",
      label: "Name",
      // Shares are declared, because auto layout hands the width to whichever
      // cell wraps first: a date breaking into three lines was taking it from
      // the name, which then truncated to four characters.
      width: "24%",
      // The identifier is not here. It says nothing a reader of this list is
      // asking, and it is on the world's own page, next to a copy button.
      render: (world) => <a className="row-link" href={routeHash({ page: "worlds", accessTab: "users", gameId: game?.id ?? null, worldId: world.id })}>{world.displayName}</a>,
    },
    {
      id: "release",
      label: "Preset and release",
      width: "20%",
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
      width: "16%",
      render: (world) => {
        const wipe = world.wipes.find((item) => item.state === "current") ?? world.wipes.at(-1);
        return wipe
          ? <span title="A wipe is one generation of this world. Starting a new one keeps every backup of the old one."><strong className="num">#{wipe.number}</strong><small className="nowrap">Opened {formatDate(wipe.createdAt)}</small></span>
          : <Ghost>{world.worldLifecycleAvailable ? "No wipes yet" : "Legacy world"}</Ghost>;
      },
    },
    {
      id: "address",
      label: "Address",
      // An address is copied, not read character by character, so it gives up
      // width before the table has to scroll.
      truncate: true,
      width: "25%",
      render: (world) => world.connectionAddress
        ? <ConnectionAddress address={world.connectionAddress} connectivity={world.connectivity} copyLabel={`Copy the address of ${world.displayName}`} />
        : <Ghost>{world.materialization !== "existing" ? "No address" : serverState === "running" ? "No address yet" : "Assigned while online"}</Ghost>,
    },
    {
      id: "actions",
      label: "Actions",
      actions: true,
      // Starting and stopping is not here. It spends money on a host the whole
      // group shares, and the list cannot show why it is refused; the world
      // page can, so the decision is made there.
      render: (world) => game
        ? <Menu items={rowActionItems({ game, world, granted, busy: pendingFor(pending, world.id) !== null, onWorldAction, onInvite, onDownloadPack })} label={`More actions for ${world.displayName}`} size="small" />
        : null,
    },
  ];

  return (
    <div className="page">
      <h1 className="visually-hidden">Worlds</h1>
      {status === "error" && <Banner actions={<Button onClick={onRefresh} variant="text">Try again</Button>} description={error} title="Current state could not be loaded" tone="error" />}
      {!fleet && <SharedHostNotice busy={controlBusy} session={sharedSession} />}

      <SessionOverview fleet={fleet} game={game} host={host} hosts={snapshot?.hosts ?? []} loading={loading} observedAt={snapshot?.observedAt} players={playersOnline(game)} reason={sessionReason(sharedSession, game)} session={session} />

      <Card
        actions={<WorldsHeaderActions canCreate={canManage && readyPreset} game={game} loading={pending?.kind === "refresh"} onCreateWorld={onCreateWorld} onRefresh={onRefresh} />}
        flush
        title={game ? `Worlds of ${game.displayName}` : "Worlds"}
      >
        <DataTable
          columns={columns}
          empty={<EmptyState description={canManage && readyPreset ? "Create the first world from a ready preset." : "Worlds appear here once a preset has a ready release and a world is created."} icon="public" title="No worlds in this game" />}
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
      <h1 className="visually-hidden">Worlds</h1>
      {failed && <Banner actions={<Button onClick={onRefresh} variant="text">Try again</Button>} description={error} title="Current state could not be loaded" tone="error" />}
      <Card flush><EmptyState description={description} icon="public" title="No games to show" /></Card>
    </div>
  );
}

function WorldsHeaderActions({ canCreate, game, loading, onCreateWorld, onRefresh }: Readonly<{
  canCreate: boolean;
  game: Game | undefined;
  loading: boolean;
  onCreateWorld: (game: Game) => void;
  onRefresh: () => void;
}>) {
  return <>
    <Button icon="refresh" loading={loading} onClick={onRefresh} variant="outlined">Refresh</Button>
    {canCreate && game && <Button icon="add" onClick={() => onCreateWorld(game)} variant="filled">Create world</Button>}
  </>;
}

function SessionOverview({ game, host, hosts, fleet, loading, observedAt, session, reason, players }: Readonly<{
  game: Game | undefined;
  host: ControlPlaneSnapshot["hosts"][number] | undefined;
  hosts: ControlPlaneSnapshot["hosts"];
  fleet: boolean;
  loading: boolean;
  observedAt: string | undefined;
  session: ReturnType<typeof sessionStatus>;
  reason: SessionReason;
  players: number | null;
}>) {
  return (
    <Card as="section" className="session-card-wrap" flush>
      <div aria-busy={loading} className="session-card">
        <div className="session-state">
          {loading ? <Skeleton height={28} width="60%" /> : <Status kind={session.kind} label={`${game?.displayName ?? "Session"} ${session.label.toLowerCase()}`} size="large" />}
          <div className="pairs">
            {loading ? <><Skeleton width="70%" /><Skeleton width="50%" /></> : <>
              <span className={reason.attention ? "session-reason session-reason-attention" : "session-reason"}>
                {fleet ? fleetReason(game) : reason.text}
                {!fleet && <Tooltip text={reason.detail}><Icon name="help" size={14} /></Tooltip>}
              </span>
              {players !== null && <span><strong>{plural(players, "player")}</strong> online</span>}
              <span>Last observed <strong>{formatDateTime(observedAt)}</strong></span>
            </>}
          </div>
        </div>
        <dl className="session-facts">
          {fleet ? <>
            <Fact label="Fleet hosts" loading={loading}>{hosts.filter((item) => item.provenance === "launched" && item.state === "running").length} running</Fact>
            <Fact label="Provisioning" loading={loading}>{hosts.filter((item) => item.provenance === "launched" && item.state === "pending").length} hosts</Fact>
          </> : <>
            <Fact label="Compute host" loading={loading}>{host ? <Status kind={hostStatus(host.state).kind} label={`${host.name} · ${hostStatus(host.state).label.toLowerCase()}`} /> : <Ghost>No host available</Ghost>}</Fact>
            <Fact label="Instance type" loading={loading} mono>{host?.instanceType ?? <Ghost>Not reported</Ghost>}</Fact>
            <Fact label="Zone" loading={loading} mono>{host?.availabilityZone ?? <Ghost>Not reported</Ghost>}</Fact>
            <Fact label="Launched" loading={loading}>{host?.launchedAt ? <Timestamp value={host.launchedAt} /> : <Ghost>Not running</Ghost>}</Fact>
          </>}
        </dl>
      </div>
    </Card>
  );
}

function fleetReason(game: Game | undefined): string {
  const state = game?.lifecycle?.observedState;
  if (state === "ready") return "This game's world is running on a fleet host.";
  if (state === "starting") return "A fleet host is being assigned or the game is starting.";
  if (state === "stopping") return "The game is saving and its host is draining.";
  if (state === "unknown") return "Spawnpoint cannot confirm this game's state.";
  return "No session for this game. Fleet hosts launch on demand.";
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
  if (state === "unavailable") return "Build status could not be loaded";
  if (activeRelease && desiredRelease && activeRelease !== desiredRelease) return `Active ${activeRelease} · desired ${desiredRelease}`;
  if (activeRelease) return `Release ${activeRelease}`;
  if (desiredRelease) return "Ready for first start";
  if (world.materialization === "not_created") return world.preset?.buildStatus === "ready" ? `First start uses ${world.preset.latestRelease ?? "the latest release"}` : `Preset ${world.preset?.buildStatus ?? "unbuilt"}`;
  if (state === "unconfigured") return "No release selected";
  return "No build selected";
}

export function sessionControlAvailability(world: World, game: Game, sharedSession: SharedHostSession, permitted: boolean, controlBusy: boolean, fleet = false): { action: SessionAction; disabled: boolean; hint: string } {
  const action = sessionActionForWorld(world, game, sharedSession, fleet);
  if (!world.sessionControlAvailable) {
    if (world.materialization === "archived") return { action, disabled: true, hint: "This world is archived. Restore a backup to open a new wipe." };
    if (world.materialization === "not_created") return { action, disabled: true, hint: "This preset needs a successful release build before its first start." };
    return { action, disabled: true, hint: "This world is not connected to a session workflow yet." };
  }
  if (!permitted) return { action, disabled: true, hint: `Your role cannot ${action} sessions.` };
  if (controlBusy || sharedSession.operationRunning) return { action, disabled: true, hint: "A control-plane operation is already in progress." };
  if (fleet) {
    const lifecycle = game.lifecycle;
    if (world.connectivity === "zerotier") return { action, disabled: true, hint: "Fleet hosts do not join ZeroTier. Choose a public connection while this world is stopped." };
    if (lifecycle?.observedState === "starting" || lifecycle?.observedState === "stopping" || lifecycle?.observedState === "unknown") return { action, disabled: true, hint: `This game is ${lifecycle.observedState}.` };
    if (action === "start" && lifecycle?.activeSessionId) return { action, disabled: true, hint: "Another world of this game is already active. Stop it first." };
    return { action, disabled: false, hint: action === "start" ? "Launch or reuse a billed fleet host" : "Save and back up this session, then drain its host" };
  }
  if (sharedSession.recoveryPending) return { action, disabled: true, hint: "Spawnpoint is reconciling the stopped host automatically." };
  if (sharedSession.state === "starting" || sharedSession.state === "stopping") return { action, disabled: true, hint: `The shared host is ${sharedSession.state}.` };
  if (sharedSession.state === "unknown") return { action, disabled: true, hint: "Spawnpoint cannot confirm that the shared host is free. Refresh before trying again." };
  if (action === "start" && sharedSession.state === "running") {
    const owner = sharedSessionOwnerLabel(sharedSession);
    return { action, disabled: true, hint: owner ? `${owner} is using the shared host. Stop that session first.` : "Another session is using the shared host. Stop it first." };
  }
  return { action, disabled: false, hint: action === "start" ? "Start a billed session on the shared host" : "Save, back up and stop this session" };
}

export function sessionActionForWorld(world: World, game: Game, sharedSession: SharedHostSession, fleet = false): SessionAction {
  if (fleet) return game.lifecycle?.activeWorldId === world.id && game.lifecycle.activeSessionId ? "stop" : "start";
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

// The network an address belongs to is a property of the address, so it rides
// in front of it as one icon instead of a caption under every row.
export function ConnectionAddress({ address, connectivity, copyLabel }: Readonly<{ address: string; connectivity: World["connectivity"]; copyLabel?: string }>) {
  const zerotier = connectivity === "zerotier";
  const network = zerotier
    ? "ZeroTier network. Reachable only from a device that joined the overlay."
    : "Public address. Reachable from the internet.";
  return (
    <span className="copy-value">
      <Tooltip className="address-network" text={network}>
        <Icon name={zerotier ? "dns" : "public"} size={16} />
        <span className="visually-hidden">{network}</span>
      </Tooltip>
      <Ellipsis mono tail={18} value={address} />
      {copyLabel && <CopyButton label={copyLabel} value={address} />}
    </span>
  );
}

export function SharedHostNotice({ session, busy }: Readonly<{ session: SharedHostSession; busy: boolean }>) {
  const owner = sharedSessionOwnerLabel(session);
  if (session.recoveryPending) {
    return <Banner description={owner ? `${owner} still owns the recorded session, although the compute host is stopped. Spawnpoint is reconciling it automatically; session controls remain locked until it finishes.` : "The compute host is stopped and Spawnpoint is reconciling its session record automatically."} title="Automatic recovery in progress" tone="info" />;
  }
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
