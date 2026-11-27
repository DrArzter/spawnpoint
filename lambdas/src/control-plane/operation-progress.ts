// What one world operation is doing now, read from its Step Functions execution
// (ADR-0015's read-only stance: nothing here writes). The history is read
// newest first and in a bounded number of pages.

import { ENDED, NESTED_STATES, stepOfState, workflowOfMachine, type OperationStep, type WorkflowName } from "./operation-steps.ts";
import type { HostLogLine } from "./host-log.ts";
import { operationWorldId } from "./world-session.ts";
import type { CaughtError, ChildProgress, OperationProgress } from "../../../contract/operations.ts";

export type { CaughtError, ChildProgress, OperationProgress };

export type ExecutionStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED" | "PENDING_REDRIVE";

export type ExecutionSummary = Readonly<{
  status: ExecutionStatus;
  startDate: Date;
  stopDate: Date | null;
  input: string | undefined;
  output: string | undefined;
  error: string | undefined;
  cause: string | undefined;
}>;

/** The part of a history event that progress needs. */
export type HistoryEvent = Readonly<{
  /** The state the event enters; set on every state-entered event. */
  entered?: string;
  /** A task that failed or timed out. */
  failure?: Readonly<{ resourceType: string | undefined; error: string | undefined; cause: string | undefined }>;
  /** The parameters a task was scheduled with; a nested execution names itself here. */
  scheduledParameters?: string;
}>;

export type HistoryPage = Readonly<{ events: readonly HistoryEvent[]; nextToken: string | undefined }>;

export type ExecutionPort = Readonly<{
  /** Null when the execution does not exist. */
  describe: (executionArn: string) => Promise<ExecutionSummary | null>;
  /** One page, newest first. */
  historyPage: (executionArn: string, nextToken: string | undefined) => Promise<HistoryPage>;
}>;



/** The host a start runs on, and when its start ran. */
export type HostRun = Readonly<{ instanceId: string; startedAt: Date; endedAt: Date | null }>;

/** A history page holds up to this many events, and no more than this many pages are read. */
export const HISTORY_PAGE_SIZE = 100;
export const HISTORY_MAX_PAGES = 3;
/** A promotion nests a start, which nests the host's start. */
const MAX_CHILD_DEPTH = 2;
const MAX_ERROR = 200;
const MAX_CAUSE = 1000;

type Reading = Readonly<{ state: string | null; nested: string | null; caught: Readonly<{ error: string; cause: string; state: string }> | null }>;

// The state names, the failure the workflow caught and the nested execution of
// the current state, from events newest first. A task failure counts as caught
// only when a later state was entered: the workflow carried on.
type Scan = { state: string | null; nested: string | null; caught: Reading["caught"]; pending: Readonly<{ error: string; cause: string }> | null; entered: boolean };

function scanEvent(scan: Scan, event: HistoryEvent, wantCaught: boolean): void {
  if (event.entered !== undefined) {
    if (scan.pending !== null) {
      scan.caught = { ...scan.pending, state: event.entered };
      scan.pending = null;
    }
    scan.state ??= event.entered;
    scan.entered = true;
    return;
  }
  if (event.scheduledParameters !== undefined) {
    if (scan.state === null && scan.nested === null) scan.nested = event.scheduledParameters;
    return;
  }
  const waiting = wantCaught && scan.entered && scan.caught === null && scan.pending === null;
  if (event.failure !== undefined && waiting) scan.pending = unwrap(event.failure);
}

async function readHistory(port: ExecutionPort, executionArn: string, wantCaught: boolean): Promise<Reading> {
  const scan: Scan = { state: null, nested: null, caught: null, pending: null, entered: false };
  let nextToken: string | undefined;
  for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
    const read = await port.historyPage(executionArn, nextToken);
    for (const event of read.events) scanEvent(scan, event, wantCaught);
    nextToken = read.nextToken;
    // The current state is found on the first page; only the caught error looks further.
    const done = scan.state !== null && (scan.caught !== null || !wantCaught);
    if (nextToken === undefined || done) break;
  }
  return { state: scan.state, nested: scan.nested, caught: scan.caught };
}

// A nested execution's failure reaches its parent as the child's description.
function unwrap(failure: NonNullable<HistoryEvent["failure"]>): Readonly<{ error: string; cause: string }> {
  const raw = { error: failure.error ?? "", cause: failure.cause ?? "" };
  if (failure.resourceType !== "states") return raw;
  try {
    const parsed: unknown = JSON.parse(raw.cause);
    if (parsed === null || typeof parsed !== "object") return raw;
    const record = parsed as Record<string, unknown>;
    const error = record.Error ?? record.error;
    const cause = record.Cause ?? record.cause;
    if (typeof error !== "string") return raw;
    return { error, cause: typeof cause === "string" ? cause : "" };
  } catch {
    return raw;
  }
}

// A workflow's cause can quote resource names. The panel shows what the
// workflow says, without account numbers or ARNs, and not without end.
export function scrub(text: string, limit: number): string {
  const clean = text.replace(/arn:aws[a-z-]*:[^\s"',}]+/g, "[arn]").replace(/\b\d{12}\b/g, "[account]");
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function childExecutionArn(parameters: string, rootArn: string): Readonly<{ arn: string; workflow: WorkflowName }> | null {
  try {
    const parsed: unknown = JSON.parse(parameters);
    if (parsed === null || typeof parsed !== "object") return null;
    const { StateMachineArn: machine, Name: name } = parsed as Record<string, unknown>;
    if (typeof machine !== "string" || typeof name !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) return null;
    const workflow = workflowOfMachine(machine);
    // A child lives in the same account and region as its parent.
    const scope = (arn: string) => arn.split(":").slice(0, 5).join(":");
    if (workflow === null || scope(machine) !== scope(rootArn)) return null;
    const parts = machine.split(":");
    parts[5] = "execution";
    return { arn: `${parts.join(":")}:${name}`, workflow };
  } catch {
    return null;
  }
}

function childType(workflow: WorkflowName): ChildProgress["type"] | null {
  if (workflow === "start" || workflow === "start-host") return "start";
  return workflow === "stop" || workflow === "stop-host" ? "stop" : null;
}

// The deepest nested start or stop that is running, with its current step.
async function deepestChild(
  port: ExecutionPort,
  parent: Readonly<{ arn: string; workflow: WorkflowName; state: string | null; nested: string | null }>,
  depth: number,
): Promise<ChildProgress | null> {
  if (depth > MAX_CHILD_DEPTH || parent.state === null || parent.nested === null || !NESTED_STATES[parent.workflow].has(parent.state)) return null;
  const child = childExecutionArn(parent.nested, parent.arn);
  if (child === null) return null;
  const type = childType(child.workflow);
  if (type === null) return null;
  try {
    const summary = await port.describe(child.arn);
    if (summary?.status !== "RUNNING") return null;
    const reading = await readHistory(port, child.arn, false);
    const step = reading.state === null ? null : stepOfState(child.workflow, reading.state);
    if (step === null || step.key === ENDED) return null;
    const deeper = await deepestChild(port, { arn: child.arn, workflow: child.workflow, state: reading.state, nested: reading.nested }, depth + 1);
    return deeper ?? { type, step };
  } catch (error) {
    console.warn("could not read a nested execution", child.arn, error);
    return null;
  }
}

// The newest nested execution of one of these workflows, from the parent's history.
async function newestChild(port: ExecutionPort, parentArn: string, accept: readonly WorkflowName[]): Promise<Readonly<{ arn: string; workflow: WorkflowName }> | null> {
  let nextToken: string | undefined;
  for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
    const read = await port.historyPage(parentArn, nextToken);
    for (const event of read.events) {
      const child = event.scheduledParameters === undefined ? null : childExecutionArn(event.scheduledParameters, parentArn);
      if (child !== null && accept.includes(child.workflow)) return child;
    }
    nextToken = read.nextToken;
    if (nextToken === undefined) break;
  }
  return null;
}

/**
 * The host start of a start or a promotion, running or ended: the instance it
 * ran on, from the host workflow's own input. Null for other operations, or
 * when no host start was reached.
 */
export async function findHostRun(port: ExecutionPort, root: Readonly<{ arn: string; workflow: WorkflowName }>): Promise<HostRun | null> {
  let hostArn: string | null = null;
  if (root.workflow === "start") hostArn = (await newestChild(port, root.arn, ["start-host"]))?.arn ?? null;
  else if (root.workflow === "promote") {
    const start = await newestChild(port, root.arn, ["start"]);
    hostArn = start === null ? null : (await newestChild(port, start.arn, ["start-host"]))?.arn ?? null;
  }
  if (hostArn === null) return null;
  const summary = await port.describe(hostArn);
  if (summary === null) return null;
  const instanceId = instanceOfInput(summary.input);
  return instanceId === null ? null : { instanceId, startedAt: summary.startDate, endedAt: summary.stopDate };
}

/** The host a host start runs on, from its execution input; the guard holds the workflows to it. */
export function instanceOfInput(input: string | undefined): string | null {
  if (input === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed === null || typeof parsed !== "object") return null;
    // A configured start names its host in `request`; a fleet start, at the top, from its placement.
    const request = (parsed as { request?: unknown }).request;
    const nested = request !== null && typeof request === "object" ? (request as { instanceId?: unknown }).instanceId : undefined;
    const id = nested ?? (parsed as { instanceId?: unknown }).instanceId;
    return typeof id === "string" && /^i-[0-9a-f]{8,17}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function statusOf(status: ExecutionStatus): OperationProgress["status"] {
  switch (status) {
    case "RUNNING": return "running";
    case "SUCCEEDED": return "succeeded";
    case "TIMED_OUT": return "timed_out";
    case "ABORTED": return "aborted";
    default: return "failed";
  }
}

// The workflow's own verdict on a success: `status` in its output.
function resultOf(output: string | undefined): string | null {
  if (output === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(output);
    const status = parsed !== null && typeof parsed === "object" ? (parsed as { status?: unknown }).status : undefined;
    return typeof status === "string" && /^[a-z_]{1,40}$/.test(status) ? status : null;
  } catch {
    return null;
  }
}

/**
 * The progress of one execution of a known workflow. Null when it does not
 * exist or its input names another world. `expectation` is read only for a
 * running operation: the usual duration, from the same runs as the list.
 */
export async function readOperationProgress(
  port: ExecutionPort,
  request: Readonly<{
    id: string;
    type: OperationProgress["type"];
    executionArn: string;
    workflow: WorkflowName;
    worldId: string;
    now: Date;
    expectation?: () => Promise<Readonly<{ expectedSeconds: number; expectedSamples: number }> | null>;
    /** The host's lines of a start; read for a running or failed start or promotion only. */
    hostLog?: (host: HostRun) => Promise<readonly HostLogLine[]>;
  }>,
): Promise<OperationProgress | null> {
  const summary = await port.describe(request.executionArn);
  if (summary === null || operationWorldId(summary.input) !== request.worldId) return null;
  const status = statusOf(summary.status);
  const running = status === "running";
  const expectation = running ? await request.expectation?.() ?? null : null;
  const reading = await readHistory(port, request.executionArn, true);
  const end = summary.stopDate ?? request.now;
  const step = running && reading.state !== null ? stepOfState(request.workflow, reading.state) : null;
  const child = running
    ? await deepestChild(port, { arn: request.executionArn, workflow: request.workflow, state: reading.state, nested: reading.nested }, 1)
    : null;
  const failed = status === "failed" || status === "timed_out" || status === "aborted";
  const hostLog = (running || failed) && request.hostLog !== undefined ? await readHostLog(port, request, request.hostLog) : null;
  return {
    id: request.id,
    type: request.type,
    status,
    startedAt: summary.startDate.toISOString(),
    stoppedAt: summary.stopDate?.toISOString() ?? null,
    elapsedSeconds: Math.max(0, Math.round((end.getTime() - summary.startDate.getTime()) / 1000)),
    ...expectation,
    step: step !== null && step.key !== ENDED ? step : null,
    child,
    result: status === "succeeded" ? resultOf(summary.output) : null,
    failure: failed ? { error: scrub(summary.error ?? summary.status, MAX_ERROR), cause: scrub(summary.cause ?? "", MAX_CAUSE) } : null,
    ...(hostLog === null ? {} : { hostLog }),
    caught: reading.caught === null ? null : {
      error: scrub(reading.caught.error, MAX_ERROR),
      cause: scrub(reading.caught.cause, MAX_CAUSE),
      step: stepOfState(request.workflow, reading.caught.state),
    },
  };
}

// The log is a courtesy: when it cannot be read the operation is still told.
async function readHostLog(
  port: ExecutionPort,
  request: Readonly<{ executionArn: string; workflow: WorkflowName }>,
  read: (host: HostRun) => Promise<readonly HostLogLine[]>,
): Promise<readonly HostLogLine[] | null> {
  if (request.workflow !== "start" && request.workflow !== "promote") return null;
  try {
    const host = await findHostRun(port, { arn: request.executionArn, workflow: request.workflow });
    return host === null ? [] : await read(host);
  } catch (error) {
    console.warn("could not read the host log of an operation", request.executionArn, error);
    return null;
  }
}
