import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";

import { ASSISTANT_TOOL_REQUEST_KIND, type AssistantToolRequest } from "../../../contract/assistant.ts";
import type { ReadPort } from "./assistant-conversation.ts";

/**
 * A read the worker runs as the owner (ADR-0096): a direct invocation of the
 * access API, which answers it through the route's own gate. The worker holds
 * no grant to the data itself.
 */
export function lambdaAssistantReads(client: Pick<LambdaClient, "send">, functionName: () => string): ReadPort {
  return async (identityId, tool, args) => {
    const request: AssistantToolRequest = { kind: ASSISTANT_TOOL_REQUEST_KIND, identityId, tool, arguments: args };
    const result = await client.send(new InvokeCommand({
      FunctionName: functionName(),
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(JSON.stringify(request)),
    }));
    if (result.FunctionError !== undefined) return { ok: false, text: "The read failed inside Spawnpoint." };
    const reply = JSON.parse(new TextDecoder().decode(result.Payload)) as { statusCode?: number; body?: string };
    const ok = typeof reply.statusCode === "number" && reply.statusCode >= 200 && reply.statusCode < 300;
    return { ok, text: reply.body ?? "" };
  };
}
