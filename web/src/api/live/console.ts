import { apiFailure, type ConsoleEntry, type SpawnpointApi } from "../contract";
import { authorizedFetch } from "./transport";

const path = (gameId: string, worldId: string) => `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/console`;

// The console gateway (ADR-0063): a command is accepted at once and its answer
// is collected from the history, so no request waits on a host.
export const consoleApi = {
  async loadConsole(gameId: string, worldId: string): Promise<readonly ConsoleEntry[]> {
    const response = await authorizedFetch(path(gameId, worldId));
    if (!response.ok) throw await apiFailure(response, response.status === 403 ? "Your role cannot use the console." : "The console history could not be loaded.");
    return (await response.json() as { entries: ConsoleEntry[] }).entries;
  },

  async runConsoleCommand(gameId: string, worldId: string, command: string): Promise<ConsoleEntry> {
    const response = await authorizedFetch(path(gameId, worldId), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string; entry?: ConsoleEntry };
    if (!response.ok || body.entry === undefined) {
      const messages: Record<string, string> = {
        forbidden: "Your role cannot use the console.",
        invalid_command: "A command is one line of at most 256 characters.",
        lifecycle_command: "Stopping the game here would skip the verified backup. Use Stop on the world page.",
        session_not_ready: "This world is not running. Start it first.",
        console_unavailable: "Spawnpoint cannot tell which host runs this world. Refresh and try again.",
        unknown_world: "Spawnpoint does not know this world. Refresh and try again.",
      };
      throw new Error(messages[body.error ?? ""] ?? "The command could not be sent.");
    }
    return body.entry;
  },
} satisfies Partial<SpawnpointApi>;
