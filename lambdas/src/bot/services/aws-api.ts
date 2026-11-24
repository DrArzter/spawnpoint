import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

import type { ChatReply, ChatRequest } from "../../../../contract/chat.ts";
import { env } from "./aws.ts";

// The bot asks the API to run its own routes (ADR-0087); it holds no
// orchestration of its own and no grant beyond invoking the API.
const lambda = new LambdaClient({ region: env("AWS_REGION") });

export async function askApi(request: ChatRequest): Promise<ChatReply> {
  const invoked = await lambda.send(new InvokeCommand({
    FunctionName: env("ACCESS_API_FUNCTION"),
    Payload: new TextEncoder().encode(JSON.stringify(request)),
  }));
  if (invoked.FunctionError !== undefined) throw new Error(`the API failed: ${invoked.FunctionError}`);
  const reply = JSON.parse(new TextDecoder().decode(invoked.Payload)) as Partial<ChatReply>;
  if (typeof reply.statusCode !== "number" || typeof reply.body !== "string") throw new Error("the API answered without a status");
  return { statusCode: reply.statusCode, body: reply.body };
}
