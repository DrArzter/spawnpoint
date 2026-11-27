import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DescribeExecutionCommand, ListExecutionsCommand, type SFNClient } from "@aws-sdk/client-sfn";

import { provenGameKey } from "../domain/proven-games.ts";

/*
 * Which games have had a session reach ready in this deployment (ADR-0109).
 * The stored proof (`proven#<game>`, written by the lifecycle coordinator) is
 * the source. A game ready before that writer was deployed has no proof yet,
 * so the finished start runs Step Functions keeps (90 days) fill in for it,
 * read-only, until its next ready session writes one.
 */

type Machine = Readonly<{ type: string; arn: string }>;

const CACHE_MS = 60_000;
const LIST_TTL_MS = 5 * 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const DESCRIBE_BATCH = 10;
const MAX_DESCRIBED = 1000;

function parse(value: string | undefined): Readonly<Record<string, unknown>> | null {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The game a finished start proved, or null: it must have answered `ready`. */
export function gameProvedByStart(input: Readonly<Record<string, unknown>> | null, output: Readonly<Record<string, unknown>> | null): string | null {
  if (output?.status !== "ready") return null;
  if (typeof input?.gameId === "string") return input.gameId;
  // A caller that predates the gameId field named the game by its serverId (ADR-0062).
  return typeof input?.serverId === "string" && !input.serverId.includes("#") ? input.serverId : null;
}

export function createProvenGamesReader(deps: Readonly<{
  document: DynamoDBDocumentClient;
  sfn: SFNClient;
  tableName: () => string | undefined;
  machines: () => readonly Machine[];
  gameIds: () => readonly string[];
  now?: () => number;
}>): () => Promise<ReadonlySet<string>> {
  const now = deps.now ?? Date.now;
  let cached: Readonly<{ at: number; games: ReadonlySet<string> }> | null = null;
  let listed: Readonly<{ at: number; arns: readonly string[] }> | null = null;
  const described = new Map<string, string | null>();

  // A game whose proof cannot be read counts as proven: a failed read must not hide a game that runs.
  async function stored(gameId: string, tableName: string): Promise<boolean> {
    try {
      const response = await deps.document.send(new GetCommand({ TableName: tableName, Key: { server_id: provenGameKey(gameId) }, ProjectionExpression: "game_id" }));
      return response.Item !== undefined;
    } catch (error) {
      console.warn("could not read a game's proof", gameId, error);
      return true;
    }
  }

  async function finishedStarts(arn: string): Promise<readonly string[]> {
    if (listed && now() - listed.at < LIST_TTL_MS) return listed.arns;
    const arns: string[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await deps.sfn.send(new ListExecutionsCommand({ stateMachineArn: arn, statusFilter: "SUCCEEDED", maxResults: PAGE_SIZE, ...(nextToken ? { nextToken } : {}) })); // NOSONAR paginated: the next token comes from the previous page
      for (const execution of response.executions ?? []) if (execution.executionArn) arns.push(execution.executionArn);
      nextToken = response.nextToken;
      if (!nextToken) break;
    }
    listed = { at: now(), arns };
    return arns;
  }

  async function provedBy(executionArn: string): Promise<string | null> {
    if (described.has(executionArn)) return described.get(executionArn) ?? null;
    const response = await deps.sfn.send(new DescribeExecutionCommand({ executionArn }));
    const game = gameProvedByStart(parse(response.input), parse(response.output));
    if (described.size >= MAX_DESCRIBED) described.clear();
    described.set(executionArn, game);
    return game;
  }

  // Newest first, and only until every game still missing is found.
  async function fromStarts(missing: Set<string>): Promise<ReadonlySet<string>> {
    const found = new Set<string>();
    try {
      const start = deps.machines().find((machine) => machine.type === "start");
      if (!start) return found;
      const arns = await finishedStarts(start.arn);
      for (let at = 0; at < arns.length && found.size < missing.size; at += DESCRIBE_BATCH) {
        const games = await Promise.all(arns.slice(at, at + DESCRIBE_BATCH).map(provedBy)); // NOSONAR batches keep DescribeExecution within its rate limit
        for (const game of games) if (game !== null && missing.has(game)) found.add(game);
      }
    } catch (error) {
      console.warn("could not read the finished starts for game proofs", error);
    }
    return found;
  }

  return async () => {
    if (cached && now() - cached.at < CACHE_MS) return cached.games;
    const ids = deps.gameIds();
    const tableName = deps.tableName();
    if (!tableName) return new Set(ids);
    const proven = new Set<string>();
    const results = await Promise.all(ids.map(async (id) => [id, await stored(id, tableName)] as const));
    for (const [id, isProven] of results) if (isProven) proven.add(id);
    const missing = new Set(ids.filter((id) => !proven.has(id)));
    if (missing.size > 0) for (const id of await fromStarts(missing)) proven.add(id);
    cached = { at: now(), games: proven };
    return proven;
  };
}
