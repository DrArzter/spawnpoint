import { type Identity } from "../../access/domain.ts";
import { type CatalogGame } from "../../control-plane/catalog.ts";
import { checkConsoleCommand, encodeConsoleCommand, type ConsoleEntry, consoleResult, type ConsoleGateway, type ConsoleRecords, type ConsoleTarget } from "../../control-plane/console.ts";
import { type WorldPlacement } from "../../control-plane/world-session.ts";
import { type Response, response, parseJsonObject, errorResponse } from "./http.ts";

// --- The console gateway (ADR-0063) -------------------------------------------
// A command is sent and recorded at once; its answer is collected when the
// history is next read, so no request waits on a host.

const CONSOLE_HISTORY_LIMIT = 30;

/** The MCP client a command came through (ADR-0061), named as it registered. */
export type ConsoleAgent = Readonly<{ clientId: string; name: string }>;

/** A world's session as the console sees it: ready on a host, or why not. */
export type ConsoleSession =
  | Readonly<{ kind: "ready"; sessionId: string; target: ConsoleTarget }>
  | Readonly<{ kind: "not_ready" }>
  | Readonly<{ kind: "no_host" }>;

/** What the console needs, injected so that it depends on no cloud API. */
export type ConsoleDependencies = Readonly<{
  /** The catalog with preset worlds, as the panel sees it. */
  catalog: () => Promise<readonly CatalogGame[]>;
  session: (gameId: string, worldId: string, placement: WorldPlacement) => Promise<ConsoleSession>;
  gateway: Pick<ConsoleGateway, "send" | "read">;
  records: ConsoleRecords;
  now: () => Date;
}>;

export type ConsoleFeature = Readonly<{
  runConsoleCommand: (identity: Identity, gameId: string, worldId: string, body: string | undefined, agent?: ConsoleAgent | null) => Promise<Response>;
  consoleHistory: (gameId: string, worldId: string) => Promise<Response>;
  /** One command's answer, for an agent that sent it: it has to be among the world's recent commands. */
  consoleCommandResult: (gameId: string, worldId: string, commandId: string) => Promise<Response>;
}>;

export function consoleFeature(dependencies: ConsoleDependencies): ConsoleFeature {
  const { catalog, session, gateway, records, now } = dependencies;

  async function entries(gameId: string, worldId: string): Promise<readonly ConsoleEntry[]> {
    const recent = await records.recent(gameId, worldId, CONSOLE_HISTORY_LIMIT);
    return Promise.all(recent.map(async ({ entry, hostId }) => {
      if (entry.status !== "pending" || entry.id === "" || hostId === null) return entry;
      const result = consoleResult(await gateway.read(entry.id, hostId));
      if (result.status === "pending") return entry;
      await records.settle(entry, result);
      return { ...entry, status: result.status, output: result.output };
    }));
  }

  return {
    async runConsoleCommand(identity, gameId, worldId, body, agent = null) {
      const parsed = parseJsonObject({ body });
      const world = (await catalog()).find((game) => game.id === gameId)?.worlds.find((candidate) => candidate.id === worldId);
      if (world === undefined) return errorResponse(404, "unknown_world");
      const check = checkConsoleCommand(gameId, parsed.command);
      if (!check.ok) return errorResponse(check.reason === "lifecycle_command" ? 409 : 400, check.reason);

      // The world's own session, ready: a console attaches to a game that answers.
      const found = await session(gameId, worldId, world.placement === "fleet" ? "fleet" : "configured");
      if (found.kind === "not_ready") return errorResponse(409, "session_not_ready");
      if (found.kind === "no_host") return errorResponse(409, "console_unavailable");

      const commandId = await gateway.send(found.target, encodeConsoleCommand(check.command));
      const entry: ConsoleEntry = {
        id: commandId, at: now().toISOString(), identityId: identity.id, displayName: identity.displayName,
        agent: agent?.name ?? null, worldId, command: check.command, status: "pending", output: null,
      };
      await records.append({ entry, gameId, sessionId: found.sessionId, hostId: found.target.hostId, agentClientId: agent?.clientId ?? null });
      return response(202, { entry });
    },
    async consoleHistory(gameId, worldId) {
      return response(200, { entries: await entries(gameId, worldId) });
    },
    async consoleCommandResult(gameId, worldId, commandId) {
      const entry = (await entries(gameId, worldId)).find((candidate) => candidate.id === commandId);
      return entry === undefined ? errorResponse(404, "unknown_command") : response(200, { entry });
    },
  };
}
