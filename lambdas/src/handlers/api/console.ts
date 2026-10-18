import { type Identity } from "../../access/domain.ts";
import { awsControlPlaneSources, sendConsoleCommand, readConsoleInvocation } from "../../control-plane/aws.ts";
import { catalogWithPresets, gameCatalog } from "../../control-plane/catalog.ts";
import { checkConsoleCommand, encodeConsoleCommand, CONSOLE_RECORD_DAYS, type ConsoleEntry, consoleResult, consoleEntryFromItem } from "../../control-plane/console.ts";
import { type WorldPlacement } from "../../control-plane/world-session.ts";
import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Response, response } from "./http.ts";
import { readWorldSession, locateWorldHost } from "./world-state.ts";
import { document, tableName } from "./access-store.ts";

// --- The console gateway (ADR-0063) -------------------------------------------
// A command is sent and recorded at once; its answer is collected when the
// history is next read, so no request waits on a host.

const CONSOLE_HISTORY_LIMIT = 30;

/** The MCP client a command came through (ADR-0061), named as it registered. */
export type ConsoleAgent = Readonly<{ clientId: string; name: string }>;

export async function runConsoleCommand(identity: Identity, gameId: string, worldId: string, body: string | undefined, agent: ConsoleAgent | null = null): Promise<Response> {
  let parsed: { command?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const [presets, worldRecords, hosts] = await Promise.all([
    awsControlPlaneSources.listPresets?.() ?? Promise.resolve([]),
    awsControlPlaneSources.listWorldRecords?.() ?? Promise.resolve([]),
    awsControlPlaneSources.listHosts(),
  ]);
  const world = catalogWithPresets(presets, gameCatalog, worldRecords)
    .find((game) => game.id === gameId)?.worlds.find((candidate) => candidate.id === worldId);
  if (world === undefined) return response(404, { error: "unknown_world" });
  const check = checkConsoleCommand(gameId, parsed.command);
  if (!check.ok) return response(check.reason === "lifecycle_command" ? 409 : 400, { error: check.reason });

  // The world's own session, ready: a console attaches to a game that answers.
  const placement: WorldPlacement = world.placement === "fleet" ? "fleet" : "configured";
  const located = await readWorldSession(gameId, worldId, placement);
  const sessionId = located.record?.activeSessionId;
  if (located.record?.observedState !== "ready" || !sessionId) return response(409, { error: "session_not_ready" });

  const target = await locateWorldHost(placement, located.record, hosts);
  if (target === null) return response(409, { error: "console_unavailable" });

  const commandId = await sendConsoleCommand({ hostId: target.hostId, worldId, slot: target.slot, encodedCommand: encodeConsoleCommand(check.command) });
  const at = new Date().toISOString();
  await document.send(new PutCommand({ TableName: tableName, Item: {
    pk: `CONSOLE#${worldId}`, sk: `${at}#${commandId}`, command_id: commandId, created_at: at,
    identity_id: identity.id, display_name: identity.displayName, game_id: gameId, world_id: worldId,
    session_id: sessionId, host_id: target.hostId, command: check.command, status: "pending",
    ...(agent === null ? {} : { agent_client_id: agent.clientId, agent_name: agent.name }),
    ttl: Math.floor(Date.now() / 1000) + CONSOLE_RECORD_DAYS * 24 * 3600,
  } }));
  const entry: ConsoleEntry = { id: commandId, at, identityId: identity.id, displayName: identity.displayName, agent: agent?.name ?? null, worldId, command: check.command, status: "pending", output: null };
  return response(202, { entry });
}

async function consoleEntries(gameId: string, worldId: string): Promise<readonly ConsoleEntry[]> {
  const page = await document.send(new QueryCommand({
    TableName: tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": `CONSOLE#${worldId}` },
    ScanIndexForward: false, Limit: CONSOLE_HISTORY_LIMIT,
  }));
  const items = (page.Items ?? []).filter((item) => item.game_id === gameId);
  const settled = await Promise.all(items.map(async (item) => {
    if (item.status !== "pending" || typeof item.command_id !== "string" || typeof item.host_id !== "string") return item;
    const result = consoleResult(await readConsoleInvocation(item.command_id, item.host_id));
    if (result.status === "pending") return item;
    try {
      await document.send(new UpdateCommand({
        TableName: tableName, Key: { pk: item.pk, sk: item.sk },
        UpdateExpression: "SET #status = :status, #output = :output, completed_at = :now",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status", "#output": "output" },
        ExpressionAttributeValues: { ":status": result.status, ":output": result.output, ":now": new Date().toISOString(), ":pending": "pending" },
      }));
    } catch (error) {
      // Another reader settled it first; its answer is the same.
      if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
    }
    return { ...item, status: result.status, output: result.output };
  }));
  return settled.map(consoleEntryFromItem);
}

export async function consoleHistory(gameId: string, worldId: string): Promise<Response> {
  return response(200, { entries: await consoleEntries(gameId, worldId) });
}

// One command's answer, for an agent that sent it: it has to be among the
// world's recent commands, as the panel's history shows them.
export async function consoleCommandResult(gameId: string, worldId: string, commandId: string): Promise<Response> {
  const entry = (await consoleEntries(gameId, worldId)).find((candidate) => candidate.id === commandId);
  return entry === undefined ? response(404, { error: "unknown_command" }) : response(200, { entry });
}
