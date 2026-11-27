import { GetLogEventsCommand, ResourceNotFoundException, type CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { ListCommandsCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { DescribeExecutionCommand, ExecutionDoesNotExist, GetExecutionHistoryCommand, type HistoryEvent as SfnEvent, type SFNClient } from "@aws-sdk/client-sfn";

import { filterHostLog, type HostLogLine, type RawLogEvent } from "./host-log.ts";
import type { OperationExpectation } from "./operation-eta.ts";
import { HISTORY_PAGE_SIZE, readOperationProgress, type HostRun, type ExecutionPort, type ExecutionStatus, type HistoryEvent, type OperationProgress } from "./operation-progress.ts";
import { workflowOfMachine } from "./operation-steps.ts";
import { progressOfRecord, type HostCommand, type OperationRecordStore } from "./operation-record-progress.ts";

type Machine = Readonly<{ type: OperationProgress["type"]; arn: string }>;

// The id a panel request gives the workflow it starts names the workflow.
const OPERATION_ID = /^panel-(promote|start|stop|world-[a-z]+)-[A-Za-z0-9-]{1,64}$/;

/** The operation type an id names; null for an id this panel never made. */
export function operationTypeOfId(operationId: string): OperationProgress["type"] | null {
  const kind = OPERATION_ID.exec(operationId)?.[1];
  if (kind === undefined) return null;
  return kind.startsWith("world-") ? "world" : kind as OperationProgress["type"];
}

function historyEvent(event: SfnEvent): HistoryEvent {
  const type = event.type ?? "";
  if (type.endsWith("StateEntered")) return { entered: event.stateEnteredEventDetails?.name ?? "" };
  if (type === "TaskScheduled") return { scheduledParameters: event.taskScheduledEventDetails?.parameters ?? "" };
  const details = event.taskFailedEventDetails ?? event.taskTimedOutEventDetails;
  if (details) return { failure: { resourceType: details.resourceType, error: details.error, cause: details.cause } };
  const lambda = event.lambdaFunctionFailedEventDetails ?? event.lambdaFunctionTimedOutEventDetails ?? event.activityFailedEventDetails;
  return lambda ? { failure: { resourceType: undefined, error: lambda.error, cause: lambda.cause } } : {};
}

export function sfnExecutionPort(sfn: Pick<SFNClient, "send">): ExecutionPort {
  return {
    async describe(executionArn) {
      try {
        const described = await sfn.send(new DescribeExecutionCommand({ executionArn }));
        if (!described.startDate || !described.status) return null;
        return {
          status: described.status as ExecutionStatus,
          startDate: described.startDate,
          stopDate: described.stopDate ?? null,
          input: described.input,
          output: described.output,
          error: described.error,
          cause: described.cause,
        };
      } catch (error) {
        if (error instanceof ExecutionDoesNotExist) return null;
        throw error;
      }
    },
    async historyPage(executionArn, nextToken) {
      const page = await sfn.send(new GetExecutionHistoryCommand({
        executionArn,
        reverseOrder: true,
        maxResults: HISTORY_PAGE_SIZE,
        // A nested execution names itself in the parameters of the task that starts it.
        includeExecutionData: true,
        ...(nextToken ? { nextToken } : {}),
      }));
      return { events: (page.events ?? []).map(historyEvent), nextToken: page.nextToken };
    },
  };
}

/** The log group the host's start commands write their output to (infra/terraform/iam.tf). */
export const SESSION_COMMAND_LOG_GROUP = "/spawnpoint/session-commands";
/** Events read from the end of each stream; the filter keeps the few worth showing. */
export const LOG_EVENTS_PER_STREAM = 200;
// A command is sent shortly after its workflow starts; its clock may differ a little.
const COMMAND_SLACK_MS = 60_000;
const COMMAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * The host step documents whose output reaches the log group, each with the
 * stream segment of its one step (infra/terraform/session-documents.tf,
 * ADR-0082). AWS-RunShellScript is the host step of a session started before
 * the documents existed.
 */
const SESSION_COMMAND_STREAMS: Readonly<Record<string, string>> = {
  "spawnpoint-start-session": "startSession",
  "spawnpoint-stop-session": "stopSession",
  "AWS-RunShellScript": "aws-runShellScript",
};

export type HostLogReader = (host: HostRun) => Promise<readonly HostLogLine[]>;

/**
 * The tail of the host's newest session command inside the start's window, as
 * filtered lines. The command and its streams are looked up once and kept;
 * a stream that does not exist yet reads as empty.
 */
export function createHostLogReader(deps: Readonly<{ ssm: Pick<SSMClient, "send">; logs: Pick<CloudWatchLogsClient, "send"> }>): HostLogReader {
  const commands = new Map<string, Readonly<{ id: string; step: string }>>();
  return async (host) => {
    const key = `${host.instanceId}|${host.startedAt.toISOString()}`;
    let command = commands.get(key);
    if (command === undefined) {
      const found = await deps.ssm.send(new ListCommandsCommand({
        InstanceId: host.instanceId,
        MaxResults: 10,
        Filters: [{ key: "InvokedAfter", value: new Date(host.startedAt.getTime() - COMMAND_SLACK_MS).toISOString() }],
      }));
      const end = host.endedAt === null ? Infinity : host.endedAt.getTime() + COMMAND_SLACK_MS;
      const newest = (found.Commands ?? [])
        .filter((command) => command.DocumentName !== undefined && Object.hasOwn(SESSION_COMMAND_STREAMS, command.DocumentName) && command.CommandId !== undefined && COMMAND_ID.test(command.CommandId) && (command.RequestedDateTime?.getTime() ?? 0) <= end)
        .sort((a, b) => (b.RequestedDateTime?.getTime() ?? 0) - (a.RequestedDateTime?.getTime() ?? 0))[0];
      if (newest?.CommandId === undefined || newest.DocumentName === undefined) return [];
      command = { id: newest.CommandId, step: SESSION_COMMAND_STREAMS[newest.DocumentName] ?? "" };
      if (commands.size >= 200) commands.clear();
      commands.set(key, command);
    }
    return commandTail(deps.logs, { commandId: command.id, instanceId: host.instanceId, step: command.step });
  };
}

// The tail of one command's output on one host, as filtered lines. A stream that
// does not exist yet reads as empty.
async function commandTail(
  logs: Pick<CloudWatchLogsClient, "send">,
  command: Readonly<{ commandId: string; instanceId: string; step: string }>,
): Promise<readonly HostLogLine[]> {
  const tails = await Promise.all(["stdout", "stderr"].map(async (stream) => {
    try {
      const page = await logs.send(new GetLogEventsCommand({
        logGroupName: SESSION_COMMAND_LOG_GROUP,
        logStreamName: `${command.commandId}/${command.instanceId}/${command.step}/${stream}`,
        startFromHead: false,
        limit: LOG_EVENTS_PER_STREAM,
      }));
      return (page.events ?? []).flatMap((event): RawLogEvent[] => event.timestamp === undefined || event.message === undefined ? [] : [{ timestamp: event.timestamp, message: event.message }]);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return [];
      throw error;
    }
  }));
  return filterHostLog(tails.flat());
}

const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;

/**
 * The host log of a command the record names (ADR-0105): no command lookup.
 * The host start sends `spawnpoint-start-session`, whose one step is `startSession`.
 */
export function createCommandLogReader(deps: Readonly<{ logs: Pick<CloudWatchLogsClient, "send"> }>): (command: HostCommand) => Promise<readonly HostLogLine[]> {
  return async ({ instanceId, commandId }) => {
    if (!INSTANCE_ID.test(instanceId) || !COMMAND_ID.test(commandId)) return [];
    return commandTail(deps.logs, { commandId, instanceId, step: SESSION_COMMAND_STREAMS["spawnpoint-start-session"]! });
  };
}

export type OperationProgressReader = (request: Readonly<{ worldId: string; operationId: string }>) => Promise<OperationProgress | null>;

/**
 * Null for an id that names no operation here, or one of another world. The
 * record answers first (ADR-0105); an operation without one started before the
 * records did, and is read from its execution, with one log line per read.
 */
export function createOperationProgressReader(deps: Readonly<{
  sfn: Pick<SFNClient, "send">;
  hostLog?: HostLogReader;
  records?: OperationRecordStore | null;
  commandLog?: (command: HostCommand) => Promise<readonly HostLogLine[]>;
  machines: () => readonly Machine[];
  expectation: (machineArn: string, worldId: string) => Promise<OperationExpectation | null>;
  now?: () => Date;
}>): OperationProgressReader {
  const port = sfnExecutionPort(deps.sfn);
  const now = () => (deps.now ?? (() => new Date()))();
  return async ({ worldId, operationId }) => {
    const record = deps.records ? await deps.records.get(operationId) : null;
    if (record !== null) {
      if (record.worldId !== worldId || record.parentId !== null) return null;
      const machine = deps.machines().find((candidate) => candidate.type === record.type);
      return progressOfRecord(deps.records!, record, {
        now: now(),
        ...(machine === undefined ? {} : { expectation: () => deps.expectation(machine.arn, worldId) }),
        ...(deps.commandLog === undefined ? {} : { hostLog: deps.commandLog }),
      });
    }
    const progress = await readFromExecution(worldId, operationId);
    if (deps.records && progress !== null) console.info("operation_record_fallback", JSON.stringify({ reader: "progress", operationId, status: progress.status }));
    return progress;
  };

  async function readFromExecution(worldId: string, operationId: string): Promise<OperationProgress | null> {
    const type = operationTypeOfId(operationId);
    const machine = type === null ? undefined : deps.machines().find((candidate) => candidate.type === type);
    const workflow = machine === undefined ? null : workflowOfMachine(machine.arn);
    if (type === null || machine === undefined || workflow === null) return null;
    return readOperationProgress(port, {
      id: operationId,
      type,
      executionArn: `${machine.arn.replace(":stateMachine:", ":execution:")}:${operationId}`,
      workflow,
      worldId,
      now: now(),
      expectation: () => deps.expectation(machine.arn, worldId),
      ...(deps.hostLog === undefined ? {} : { hostLog: deps.hostLog }),
    });
  }
}
