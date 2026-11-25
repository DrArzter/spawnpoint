import type { ConsoleEntry, SpawnpointApi } from "../contract";
import { request } from "./request";
import { t } from "../../i18n";

const path = (gameId: string, worldId: string) => `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/console`;

// The console gateway (ADR-0063): a command is accepted at once and its answer
// is collected from the history, so no request waits on a host.
export const consoleApi = {
  async loadConsole(gameId: string, worldId: string): Promise<readonly ConsoleEntry[]> {
    const body = await request<{ entries: ConsoleEntry[] }>(path(gameId, worldId), {
      failure: t("rcon.consoleHistoryCouldNot"),
      refusals: { forbidden: t("rcon.roleCannotUseConsole") },
    });
    return body.entries;
  },

  async runConsoleCommand(gameId: string, worldId: string, command: string): Promise<ConsoleEntry> {
    const body = await request<{ entry?: ConsoleEntry }>(path(gameId, worldId), {
      method: "POST", body: { command },
      failure: t("rcon.commandCouldNotSent"),
      refusals: { forbidden: t("rcon.roleCannotUseConsole") },
      valid: (result) => result.entry !== undefined,
    });
    return body.entry as ConsoleEntry;
  },
} satisfies Partial<SpawnpointApi>;
