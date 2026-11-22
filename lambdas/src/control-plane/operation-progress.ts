// What one world operation is doing now, read from its Step Functions execution
// (ADR-0015's read-only stance: nothing here writes). The history is read
// newest first and in a bounded number of pages.

import { ENDED, NESTED_STATES, stepOfState, workflowOfMachine, type OperationStep, type WorkflowName } from "./operation-steps.ts";
import { operationWorldId } from "./world-session.ts";

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

export type ChildProgress = Readonly<{ type: "start" | "stop"; step: OperationStep }>;
export type CaughtError = Readonly<{ error: string; cause: string; step: OperationStep | null }>;

export type OperationProgress = Readonly<{
  id: string;
  type: "start" | "stop" | "promote" | "world";
  status: "running" | "succeeded" | "failed" | "timed_out" | "aborted";
  startedAt: string;
  stoppedAt: string | null;
  elapsedSeconds: number;
  expectedSeconds?: number;
  expectedSamples?: number;
  step: OperationStep | null;
  child: ChildProgress | null;
  result: string | null;
  failure: Readonly<{ error: string; cause: string }> | null;
  caught: CaughtError | null;
}>;

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
async function readHistory(port: ExecutionPort, executionArn: string, wantCaught: boolean): Promise<Reading> {
  let state: string | null = null;
  let nested: string | null = null;
  let caught: Reading["caught"] = null;
  let pending: Readonly<{ error: string; cause: string }> | null = null;
  let entered = false;
  let nextToken: string | undefined;
  for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
    const read = await port.historyPage(executionArn, nextToken);
    for (const event of read.events) {
      if (event.entered !== undefined) {
        if (pending !== null) {
          caught = { ...pending, state: event.entered };
          pending = null;
        }
        if (state === null) state = event.entered;
        entered = true;
      } else if (event.scheduledParameters !== undefined && state === null && nested === null) {
        nested = event.scheduledParameters;
      } else if (event.failure !== undefined && wantCaught && entered && caught === null && pending === null) {
        pending = unwrap(event.failure);
      }
    }
    nextToken = read.nextToken;
    // The current state is found on the first page; only the caught error looks further.
    if (nextToken === undefined || (state !== null && (caught !== null || !wantCaught))) break;
  }
  return { state, nested, caught };
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
    caught: reading.caught === null ? null : {
      error: scrub(reading.caught.error, MAX_ERROR),
      cause: scrub(reading.caught.cause, MAX_CAUSE),
      step: stepOfState(request.workflow, reading.caught.state),
    },
  };
}
