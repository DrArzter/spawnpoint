import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";

import type { AssistantWorker } from "./assistant.ts";
import type { TurnStarter } from "./assistant-conversation.ts";

/** Hands a job to the assistant's worker Lambda without waiting for it (ADR-0094). */
export function lambdaAssistantWorker(client: Pick<LambdaClient, "send">, functionName: () => string): AssistantWorker {
  return {
    start: async (job) => {
      const result = await client.send(new InvokeCommand({
        FunctionName: functionName(),
        InvocationType: "Event",
        Payload: new TextEncoder().encode(JSON.stringify(job)),
      }));
      if (result.StatusCode !== 202) throw new Error(`the assistant worker was not started: ${String(result.StatusCode)}`);
    },
  };
}

/** Hands one conversation's turn to the worker (ADR-0096). The worker reads the conversation itself. */
export function lambdaTurnStarter(client: Pick<LambdaClient, "send">, functionName: () => string): TurnStarter {
  return async (identityId, conversationId) => {
    const result = await client.send(new InvokeCommand({
      FunctionName: functionName(),
      InvocationType: "Event",
      Payload: new TextEncoder().encode(JSON.stringify({ kind: "conversation", identityId, conversationId })),
    }));
    if (result.StatusCode !== 202) throw new Error(`the assistant worker was not started: ${String(result.StatusCode)}`);
  };
}
