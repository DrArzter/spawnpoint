import { type Identity } from "../../access/domain.ts";
import { type CatalogGame } from "../../control-plane/catalog.ts";
import { type ConsoleGateway } from "../../control-plane/console.ts";
import { redactLog, type WorldLogRead, type WorldLogRecords, worldLogResult } from "../../control-plane/world-log.ts";
import { type WorldPlacement } from "../../control-plane/world-session.ts";
import { type ConsoleSession } from "./console.ts";
import { type Response, response, errorResponse } from "./http.ts";

// --- A world's recent log (ADR-0094) ------------------------------------------
// A read is sent and recorded at once; the log is fetched from the host's
// answer when the read is next asked for, and redacted every time. The access
// table keeps who asked, never the log.

/** What the log feature needs, injected so that it depends on no cloud API. */
export type WorldLogDependencies = Readonly<{
  catalog: () => Promise<readonly CatalogGame[]>;
  session: (gameId: string, worldId: string, placement: WorldPlacement) => Promise<ConsoleSession>;
  gateway: Pick<ConsoleGateway, "readLog" | "read">;
  records: WorldLogRecords;
  /** The names on the world's whitelist, which the redaction also hides. */
  knownNames: (gameId: string, worldId: string) => Promise<readonly string[]>;
  now: () => Date;
}>;

export type WorldLogFeature = Readonly<{
  requestLog: (identity: Identity, gameId: string, worldId: string) => Promise<Response>;
  logResult: (gameId: string, worldId: string, readId: string) => Promise<Response>;
  /** The read as the API answers it, or null when the world has no such read. */
  readLog: (gameId: string, worldId: string, readId: string) => Promise<WorldLogRead | null>;
}>;

export function worldLogFeature(dependencies: WorldLogDependencies): WorldLogFeature {
  const { catalog, session, gateway, records, knownNames, now } = dependencies;

  async function readLog(gameId: string, worldId: string, readId: string): Promise<WorldLogRead | null> {
    const record = await records.find(gameId, worldId, readId);
    if (record === null) return null;
    const result = worldLogResult(await gateway.read(record.id, record.hostId));
    const lines = result.text === null ? null : redactLog(result.text, await knownNames(gameId, worldId));
    return { id: record.id, at: record.at, status: result.status, lines };
  }

  return {
    readLog,
    async requestLog(identity, gameId, worldId) {
      const world = (await catalog()).find((game) => game.id === gameId)?.worlds.find((candidate) => candidate.id === worldId);
      if (world === undefined) return errorResponse(404, "unknown_world");
      const found = await session(gameId, worldId, world.placement === "fleet" ? "fleet" : "configured");
      if (found.kind === "not_ready") return errorResponse(409, "session_not_ready");
      if (found.kind === "no_host") return errorResponse(409, "console_unavailable");

      const id = await gateway.readLog(found.target);
      const at = now().toISOString();
      await records.append({ id, at, gameId, worldId, hostId: found.target.hostId, identityId: identity.id });
      const read: WorldLogRead = { id, at, status: "pending", lines: null };
      return response(202, { read });
    },
    async logResult(gameId, worldId, readId) {
      const read = await readLog(gameId, worldId, readId);
      return read === null ? errorResponse(404, "unknown_log_read") : response(200, { read });
    },
  };
}
