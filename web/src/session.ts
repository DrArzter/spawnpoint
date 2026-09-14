import type { ControlPlaneSnapshot, Game, ServerState, World } from "./model";

export type SharedHostSession = Readonly<{
  state: ServerState;
  activeGame: Game | null;
  activeWorld: World | null;
  operationRunning: boolean;
}>;

export function deriveSharedHostSession(snapshot: ControlPlaneSnapshot | null): SharedHostSession {
  const operations = snapshot?.operations ?? [];
  const operation = operations[0];
  const activeGames = (snapshot?.games ?? []).filter((game) => game.lifecycle?.activeSessionId != null);
  const activeGame = activeGames.length === 1 ? activeGames[0]! : null;
  const activeWorldId = activeGame?.lifecycle?.activeWorldId ?? null;
  const activeWorld = activeWorldId === null
    ? null
    : activeGame?.worlds.find((world) => world.id === activeWorldId) ?? null;

  if (operation?.type === "start") return { state: "starting", activeGame, activeWorld, operationRunning: true };
  if (operation?.type === "stop") return { state: "stopping", activeGame, activeWorld, operationRunning: true };

  const observed = activeGame?.lifecycle?.observedState;
  if (observed === "ready") return { state: "running", activeGame, activeWorld, operationRunning: operations.length > 0 };
  if (observed === "starting" || observed === "stopping") {
    return { state: observed, activeGame, activeWorld, operationRunning: operations.length > 0 };
  }

  const hostStates = snapshot?.hosts.map((host) => host.state) ?? [];
  const state: ServerState = hostStates.some((hostState) => hostState === "pending")
    ? "starting"
    : hostStates.some((hostState) => hostState === "stopping")
      ? "stopping"
      : hostStates.some((hostState) => hostState === "running")
        ? activeWorld === null ? "unknown" : "running"
        : hostStates.length > 0 ? "stopped" : "unknown";
  return { state, activeGame, activeWorld, operationRunning: operations.length > 0 };
}

export function worldOwnsSharedSession(session: SharedHostSession, game: Game, world: World): boolean {
  return session.activeGame?.id === game.id && session.activeWorld?.id === world.id;
}

export function sharedSessionOwnerLabel(session: SharedHostSession): string | null {
  if (session.activeGame === null || session.activeWorld === null) return null;
  return `${session.activeWorld.displayName} (${session.activeGame.displayName})`;
}
