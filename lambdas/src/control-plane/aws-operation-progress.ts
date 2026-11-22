import { DescribeExecutionCommand, ExecutionDoesNotExist, GetExecutionHistoryCommand, type HistoryEvent as SfnEvent, type SFNClient } from "@aws-sdk/client-sfn";

import type { OperationExpectation } from "./operation-eta.ts";
import { HISTORY_PAGE_SIZE, readOperationProgress, type ExecutionPort, type ExecutionStatus, type HistoryEvent, type OperationProgress } from "./operation-progress.ts";
import { workflowOfMachine } from "./operation-steps.ts";

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

export type OperationProgressReader = (request: Readonly<{ worldId: string; operationId: string }>) => Promise<OperationProgress | null>;

/** Null for an id that names no workflow here, an execution that is not there, or one of another world. */
export function createOperationProgressReader(deps: Readonly<{
  sfn: Pick<SFNClient, "send">;
  machines: () => readonly Machine[];
  expectation: (machineArn: string, worldId: string) => Promise<OperationExpectation | null>;
  now?: () => Date;
}>): OperationProgressReader {
  const port = sfnExecutionPort(deps.sfn);
  return async ({ worldId, operationId }) => {
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
      now: (deps.now ?? (() => new Date()))(),
      expectation: () => deps.expectation(machine.arn, worldId),
    });
  };
}
