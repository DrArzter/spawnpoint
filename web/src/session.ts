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
