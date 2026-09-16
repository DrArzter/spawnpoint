import type { ControlPlaneSnapshot, Game, ServerState, World } from "./model";

export type SharedHostSession = Readonly<{
  state: ServerState;
  activeGame: Game | null;
  activeWorld: World | null;
  operationRunning: boolean;
  recoveryPending: boolean;
}>;

export function deriveSharedHostSession(snapshot: ControlPlaneSnapshot | null): SharedHostSession {
  const operations = snapshot?.operations ?? [];
  const operation = operations[0];
  const activeGames = (snapshot?.games ?? []).filter((game) => game.lifecycle?.activeSessionId != null);
  const activeSessionAmbiguous = activeGames.length > 1;
  const activeGame = activeGames.length === 1 ? activeGames[0]! : null;
  const activeWorld = findActiveWorld(activeGame);
  const hostStates = snapshot?.hosts.map((host) => host.state) ?? [];
  const recoveryPending = hostStates.length === 1 && hostStates[0] === "stopped" &&
    activeGame?.lifecycle?.activeSessionId != null && activeGame.lifecycle.observedState !== "stopped";

  if (operation?.type === "start") return { state: "starting", activeGame, activeWorld, operationRunning: true, recoveryPending: false };
  if (operation?.type === "stop") return { state: "stopping", activeGame, activeWorld, operationRunning: true, recoveryPending: false };
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
  const subject = mine ? "this world" : owner;
  const detail = lifecycle
    ? `Spawnpoint asked for ${lifecycle.desiredState}. The host reports ${lifecycle.observedState}.`
    : "No lifecycle record for this game.";

  if (session.recoveryPending) {
    return { text: "The host stopped without being asked. Spawnpoint is reconciling the session record.", detail, attention: true };
  }
  switch (session.state) {
    case "starting":
      return { text: subject ? `Starting ${subject}` : "Starting a session", detail, attention: false };
    case "stopping":
      return { text: subject ? `Stopping ${subject}` : "Stopping the session", detail, attention: false };
    case "running":
      return { text: subject ? `The host is up for ${subject}` : "The host is up, but no world claims the session", detail, attention: subject === null };
    case "stopped":
      return { text: "Nothing is running. The host starts when somebody starts a world.", detail, attention: false };
    default:
      return { text: "Spawnpoint cannot prove what the host is doing.", detail, attention: true };
  }
}

// The one number a game server is asked for, and the only place that knows it is
// the idle watchdog, which reads it every probe to decide whether to stop.
// `null` is a read that failed; that is not the same as nobody being online.
export function playersOnline(game: Game | undefined): number | null {
  const idle = game?.lifecycle?.idle;
  if (!idle || game?.lifecycle?.observedState !== "ready") return null;
  return idle.playersOnline;
}
