import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DescribeExecutionCommand, ListExecutionsCommand, type SFNClient } from "@aws-sdk/client-sfn";

import { isSessionHost, type SessionHost } from "../domain/session-history.ts";
import { operationWorldId } from "./world-session.ts";

/*
 * Where a world's earlier sessions ran (ADR-0015). The stored history (the
 * lifecycle coordinator writes it when a session is ready and when it stops) is
 * the source. It starts when that code was deployed, so before its first entry
 * the finished Step Functions executions fill in, read-only: a V2 start that
 * succeeded names its world in its input and its host and session in its
 * output, and a V2 stop names the session in its output. Executions are kept 90
 * days, longer than any range.
 */

const HISTORY_KEY_PREFIX = "sessions#";
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const DESCRIBE_BATCH = 10;
const LIST_TTL_MS = 5 * 60 * 1000;
const MAX_CACHED_EXECUTIONS = 1000;
// A session that began before the window can still run into it. The idle
// watchdog ends a session within about 8 hours, so half a day is enough.
const SESSION_LOOKBACK_MS = 12 * 3_600_000;

type Machine = Readonly<{ type: string; arn: string }>;
type Finished = Readonly<{ executionArn: string; stopDate: Date }>;
type Described = Readonly<{ input: unknown; output: unknown }>;

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Sessions from described executions. A start gives the host and when the
 * session was ready; a stop of the same session gives when it ended. A start
 * without a stop leaves the end open, and the reader decides what that means.
 */
export function sessionHostsFromExecutions(
  worldId: string,
  starts: ReadonlyArray<Readonly<{ stopDate: Date; input: unknown; output: unknown }>>,
  stops: ReadonlyArray<Readonly<{ stopDate: Date; output: unknown }>>,
): SessionHost[] {
  const stoppedAt = new Map<string, string>();
  for (const stop of stops) {
    const sessionId = field(stop.output, "sessionId");
    if (field(stop.output, "status") === "stopped" && typeof sessionId === "string") stoppedAt.set(sessionId, stop.stopDate.toISOString());
  }
  const entries: SessionHost[] = [];
  for (const start of starts) {
    const sessionId = field(start.output, "sessionId");
    const hostId = field(field(start.output, "hostStart"), "instanceId");
    if (operationWorldId(typeof start.input === "string" ? start.input : JSON.stringify(start.input)) !== worldId) continue;
    if (field(start.output, "status") !== "ready" || typeof sessionId !== "string" || typeof hostId !== "string") continue;
    entries.push({ sessionId, hostId, startedAt: start.stopDate.toISOString(), endedAt: stoppedAt.get(sessionId) ?? null });
  }
  return entries;
}

export function createSessionHostReader(deps: Readonly<{
  sfn: SFNClient;
  document: DynamoDBDocumentClient;
  tableName: () => string | undefined;
  machines: () => readonly Machine[];
  now?: () => number;
}>): (worldId: string, sinceMs: number) => Promise<readonly SessionHost[]> {
  const now = deps.now ?? Date.now;
  // An execution's input and output never change; a failed read is not kept.
  const described = new Map<string, Described>();
  const listed = new Map<string, Readonly<{ readAt: number; runs: readonly Finished[] }>>();

  async function readStored(worldId: string): Promise<SessionHost[]> {
    const tableName = deps.tableName();
    if (!tableName) return [];
    try {
      const response = await deps.document.send(new GetCommand({ TableName: tableName, Key: { server_id: `${HISTORY_KEY_PREFIX}${worldId}` } }));
      const entries: unknown = response.Item?.entries;
      return Array.isArray(entries) ? entries.filter(isSessionHost) : [];
    } catch (error) {
      console.warn("could not read the session history of a world", worldId, error);
      return [];
    }
  }

  // Newest first; stops at the first page that ends before the window.
  async function finishedSince(machine: Machine, sinceMs: number): Promise<readonly Finished[]> {
    const key = `${machine.arn}|${Math.floor(sinceMs / 3_600_000)}`;
    const cached = listed.get(key);
    if (cached && now() - cached.readAt < LIST_TTL_MS) return cached.runs;
    const runs: Finished[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await deps.sfn.send(new ListExecutionsCommand({ stateMachineArn: machine.arn, statusFilter: "SUCCEEDED", maxResults: PAGE_SIZE, ...(nextToken ? { nextToken } : {}) })); // NOSONAR paginated: the next token comes from the previous page
      for (const execution of response.executions ?? []) {
        if (execution.executionArn && execution.stopDate && execution.stopDate.getTime() >= sinceMs) runs.push({ executionArn: execution.executionArn, stopDate: execution.stopDate });
      }
      const oldest = response.executions?.at(-1)?.stopDate;
      nextToken = response.nextToken;
      if (!nextToken || (oldest !== undefined && oldest.getTime() < sinceMs)) break;
    }
    listed.set(key, { readAt: now(), runs });
    return runs;
  }

  async function describeOne(executionArn: string): Promise<Described | null> {
    const known = described.get(executionArn);
    if (known) return known;
    try {
      const response = await deps.sfn.send(new DescribeExecutionCommand({ executionArn }));
      const result = { input: parseJson(response.input), output: parseJson(response.output) };
      if (described.size >= MAX_CACHED_EXECUTIONS) described.clear();
      described.set(executionArn, result);
      return result;
    } catch (error) {
      console.warn("could not describe a finished session workflow", executionArn, error);
      return null;
    }
  }

  async function describeAll(runs: readonly Finished[]): Promise<Array<Readonly<{ stopDate: Date; input: unknown; output: unknown }>>> {
    const results: Array<Readonly<{ stopDate: Date; input: unknown; output: unknown }>> = [];
    for (let at = 0; at < runs.length; at += DESCRIBE_BATCH) {
      const batch = await Promise.all(runs.slice(at, at + DESCRIBE_BATCH).map(async (run) => ({ run, detail: await describeOne(run.executionArn) }))); // NOSONAR batches keep DescribeExecution within its rate limit
      for (const { run, detail } of batch) if (detail) results.push({ stopDate: run.stopDate, ...detail });
    }
    return results;
  }

  async function readFromWorkflows(worldId: string, sinceMs: number): Promise<SessionHost[]> {
    try {
      const machines = deps.machines();
      const start = machines.find((machine) => machine.type === "start");
      const stop = machines.find((machine) => machine.type === "stop");
      if (!start || !stop) return [];
      const [startRuns, stopRuns] = await Promise.all([finishedSince(start, sinceMs - SESSION_LOOKBACK_MS), finishedSince(stop, sinceMs - SESSION_LOOKBACK_MS)]);
      const [starts, stops] = await Promise.all([describeAll(startRuns), describeAll(stopRuns)]);
      return sessionHostsFromExecutions(worldId, starts, stops);
    } catch (error) {
      console.warn("could not read the finished session workflows of a world", worldId, error);
      return [];
    }
  }

  return async (worldId, sinceMs) => {
    const stored = await readStored(worldId);
    const earliest = stored.reduce((least, entry) => Math.min(least, Date.parse(entry.startedAt)), Infinity);
    if (earliest <= sinceMs) return stored;
    // Stored history starts at `earliest`: the workflows answer for what came before it.
    const known = new Set(stored.map((entry) => entry.sessionId));
    const earlier = (await readFromWorkflows(worldId, sinceMs))
      .filter((entry) => !known.has(entry.sessionId) && Date.parse(entry.startedAt) < earliest);
    return [...earlier, ...stored];
  };
}
