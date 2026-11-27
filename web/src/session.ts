import type { ControlPlaneSnapshot, Game, Host, Operation, ServerState, World, WorldSession } from "./model";
import { t } from "./i18n";

export type SharedHostSession = Readonly<{
  state: ServerState;
  activeGame: Game | null;
  activeWorld: World | null;
  operationRunning: boolean;
  recoveryPending: boolean;
}>;

/*
 * Fleet worlds (ADR-0062). Each runs on a host launched for it, with a session
 * record of its own, so two worlds of one game run side by side and neither
 * waits for the other. Configured worlds share the one configured host, below.
 */

/** A fleet world's session, as the API located it: its own record, or its game's while that still names it. */
export function fleetSessionOf(world: World): WorldSession | null {
  return world.session;
}

export function fleetWorldState(game: Game, world: World): ServerState {
  const observed = fleetSessionOf(world)?.observedState;
  return observed === "ready" ? "running" : observed ?? "stopped";
}

export function fleetPlayersOnline(game: Game, world: World, nowEpochSeconds = epochSeconds()): number | null {
  return currentReading(fleetSessionOf(world), nowEpochSeconds);
}

/** This world's own state: a fleet world by its record, a configured one only while it holds the shared session. */
export function worldState(game: Game, world: World, shared: SharedHostSession): ServerState {
  if (world.placement === "fleet") return fleetWorldState(game, world);
  return worldOwnsSharedSession(shared, game, world) ? shared.state : "stopped";
}

/** The session this world holds now, if any: its own record for a fleet world, its game's for a configured one. */
export function worldSessionId(game: Game, world: World): string | null {
  const session = world.placement === "fleet" ? fleetSessionOf(world) : game.lifecycle;
  return session?.activeWorldId === world.id ? session.activeSessionId : null;
}

/** The worlds of a game whose session answers now: a fleet world on its own record, a configured one on its game's. */
export function runningWorlds(game: Game | undefined): World[] {
  if (!game) return [];
  return game.worlds.filter((world) => world.placement === "fleet"
    ? fleetWorldState(game, world) === "running"
    : game.lifecycle?.activeWorldId === world.id && game.lifecycle.observedState === "ready");
}

/** Whether this world's own session holds back a change to it, whatever its placement. */
export function worldSessionActive(game: Game, world: World): boolean {
  const holds = (session: WorldSession | null | undefined) => session?.activeWorldId === world.id &&
    (session.activeSessionId !== null || session.observedState !== "stopped");
  const unnamed = game.lifecycle != null && game.lifecycle.activeWorldId == null && game.lifecycle.activeSessionId !== null;
  return holds(world.session) || holds(game.lifecycle) || (world.placement !== "fleet" && unnamed);
}

function placementOf(snapshot: ControlPlaneSnapshot | null, worldId: string): World["placement"] {
  for (const game of snapshot?.games ?? []) {
    const world = game.worlds.find((candidate) => candidate.id === worldId);
    if (world) return world.placement ?? "configured";
  }
  return "configured";
}

/** The configured hosts: a host launched for a fleet world is never the shared one (ADR-0054, ADR-0062). */
export function configuredHosts(snapshot: ControlPlaneSnapshot | null): Host[] {
  return (snapshot?.hosts ?? []).filter((host) => host.provenance !== "launched");
}

/** The running operations of one game, and those that name no world. */
export function gameOperations(game: Game | undefined, snapshot: ControlPlaneSnapshot | null): Operation[] {
  return (snapshot?.operations ?? []).filter((operation) => operation.worldId == null || (game?.worlds.some((world) => world.id === operation.worldId) ?? false));
}

/** The running operations that hold this world back: its own, and any that name no world. */
export function operationsBlockingWorld(snapshot: ControlPlaneSnapshot | null, world: World): Operation[] {
  return (snapshot?.operations ?? []).filter((operation) => operation.worldId == null || operation.worldId === world.id ||
    (world.placement !== "fleet" && placementOf(snapshot, operation.worldId) !== "fleet"));
}

function gameOfWorld(snapshot: ControlPlaneSnapshot | null, worldId: string): Game | undefined {
  return snapshot?.games.find((game) => game.worlds.some((world) => world.id === worldId));
}

/**
 * A listed operation starts a transition and the record ends it: a start is
 * over once the record is ready, a stop once it is stopped, even while a
 * stale listing still shows the run. Without a record the operation decides.
 */
export function operationTransition(operation: Operation | undefined, observed: WorldSession["observedState"] | null | undefined): "starting" | "stopping" | null {
  if (operation?.type === "start" && observed !== "ready") return "starting";
  if (operation?.type === "stop" && observed !== "stopped") return "stopping";
  return null;
}

export function deriveSharedHostSession(snapshot: ControlPlaneSnapshot | null): SharedHostSession {
  // A fleet world's operation runs on its own host, never on the configured one.
  const operations = (snapshot?.operations ?? []).filter((operation) => operation.worldId == null || placementOf(snapshot, operation.worldId) !== "fleet");
  const operation = operations[0];
  const activeGames = (snapshot?.games ?? []).filter((game) => game.lifecycle?.activeSessionId != null);
  const activeSessionAmbiguous = activeGames.length > 1;
  const activeGame = activeGames.length === 1 ? activeGames[0]! : null;
  const activeWorld = findActiveWorld(activeGame);
  const hostStates = configuredHosts(snapshot).map((host) => host.state);
  const recoveryPending = hostStates.length === 1 && hostStates[0] === "stopped" &&
    activeGame?.lifecycle?.activeSessionId != null && activeGame.lifecycle.observedState !== "stopped";

  // activeGame is null once a stop has ended, so the record is found through the operation's world.
  const transition = operationTransition(operation, operation?.worldId == null ? undefined : gameOfWorld(snapshot, operation.worldId)?.lifecycle?.observedState);
  if (transition !== null) return { state: transition, activeGame, activeWorld, operationRunning: true, recoveryPending: false };
  if (activeSessionAmbiguous) return { state: "unknown", activeGame: null, activeWorld: null, operationRunning: operations.length > 0, recoveryPending: false };
  if (recoveryPending) return { state: "stopping", activeGame, activeWorld, operationRunning: operations.length > 0, recoveryPending: true };

  const observed = activeGame?.lifecycle?.observedState;
  if (observed === "ready") return { state: "running", activeGame, activeWorld, operationRunning: operations.length > 0, recoveryPending };
  if (observed === "starting" || observed === "stopping") {
    return { state: observed, activeGame, activeWorld, operationRunning: operations.length > 0, recoveryPending };
  }

  const state = deriveHostState(hostStates, activeWorld);
  return { state, activeGame, activeWorld, operationRunning: operations.length > 0, recoveryPending };
}

function findActiveWorld(activeGame: Game | null): World | null {
  const activeWorldId = activeGame?.lifecycle?.activeWorldId;
  if (!activeWorldId) return null;
  return activeGame.worlds.find((world) => world.id === activeWorldId) ?? null;
}

function deriveHostState(hostStates: readonly string[], activeWorld: World | null): ServerState {
  if (hostStates.includes("pending")) return "starting";
  if (hostStates.includes("stopping")) return "stopping";
  if (hostStates.includes("running")) return activeWorld === null ? "unknown" : "running";
  return hostStates.length > 0 ? "stopped" : "unknown";
}

export function worldOwnsSharedSession(session: SharedHostSession, game: Game, world: World): boolean {
  return session.activeGame?.id === game.id && session.activeWorld?.id === world.id;
}

export function sharedSessionOwnerLabel(session: SharedHostSession): string | null {
  if (session.activeGame === null || session.activeWorld === null) return null;
  return `${session.activeWorld.displayName} (${session.activeGame.displayName})`;
}

export type SessionReason = Readonly<{ text: string; detail: string; attention: boolean }>;

// The lifecycle keeps two words for this: what Spawnpoint was asked for, and
// what the host reports. They are drawn from different vocabularies — nobody
// can tell whether `running` next to `ready` is agreement or a fault — so the
// surface carries one sentence and the two raw words sit behind it.
export function sessionReason(session: SharedHostSession, game: Game | undefined, world?: World): SessionReason {
  const lifecycle = game?.lifecycle;
  const owner = sharedSessionOwnerLabel(session);
  const mine = world !== undefined && game !== undefined && worldOwnsSharedSession(session, game, world);
  const subject = mine ? t("world.world") : owner;
  const detail = lifecycle
    ? t("world.spawnpointAskedDesiredStateHost", { desiredState: lifecycle.desiredState, observedState: lifecycle.observedState })
    : t("world.noLifecycleRecordGame");

  if (session.recoveryPending) {
    return { text: t("world.hostStoppedWithoutBeing"), detail, attention: true };
  }
  switch (session.state) {
    case "starting":
      return { text: subject ? t("world.startingSubject", { subject }) : t("world.startingSession2"), detail, attention: false };
    case "stopping":
      return { text: subject ? t("world.stoppingSubject", { subject }) : t("world.stoppingSession2"), detail, attention: false };
    case "running":
      return { text: subject ? t("world.hostUpSubject", { subject }) : t("world.hostUpButNo"), detail, attention: subject === null };
    case "stopped":
      return { text: t("world.nothingRunningHostStarts"), detail, attention: false };
    default:
      return { text: t("world.spawnpointCannotProveWhat"), detail, attention: true };
  }
}

// The one number a game server is asked for, and the only place that knows it is
// the idle watchdog, which reads it every probe to decide whether to stop.
// `null` is a read that failed; that is not the same as nobody being online.
export function playersOnline(game: Game | undefined, nowEpochSeconds = epochSeconds()): number | null {
  return currentReading(game?.lifecycle, nowEpochSeconds);
}

/**
 * The next moment a shown player reading stops being current, or null. The
 * snapshot arrives only when something changes, and a watchdog that stopped
 * probing changes nothing, so the panel re-renders itself at this moment.
 */
export function nextReadingExpiry(snapshot: ControlPlaneSnapshot | null, nowEpochSeconds = epochSeconds()): number | null {
  const sessions = (snapshot?.games ?? []).flatMap((game) => [game.lifecycle, ...game.worlds.map((world) => world.session)]);
  const times = sessions.flatMap((session) => {
    const until = session?.observedState === "ready" ? session.idle?.freshUntilEpochSeconds : null;
    return typeof until === "number" && until >= nowEpochSeconds ? [until] : [];
  });
  return times.length === 0 ? null : Math.min(...times);
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// A reading past its time comes from a watchdog that stopped probing: it no
// longer says who is online, so it reads as unknown, never as its old number.
function currentReading(session: Game["lifecycle"] | null | undefined, nowEpochSeconds: number): number | null {
  const idle = session?.idle;
  if (!idle || session?.observedState !== "ready") return null;
  const freshUntil = idle.freshUntilEpochSeconds;
  if (typeof freshUntil === "number" && freshUntil < nowEpochSeconds) return null;
  return idle.playersOnline;
}
