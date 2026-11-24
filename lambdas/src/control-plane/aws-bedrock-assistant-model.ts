import { type BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

import type { AssistantModelPort } from "./assistant.ts";

/**
 * The assistant's model over Bedrock's Converse API (ADR-0094), through an EU
 * inference profile, so the log stays in the EU. The model gets no tool.
 */
export function bedrockAssistantModel(client: Pick<BedrockRuntimeClient, "send">): AssistantModelPort {
  return {
    answer: async ({ modelId, system, prompt, maxTokens }) => {
      const reply = await client.send(new ConverseCommand({
        modelId,
        system: [{ text: system }],
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens },
      }));
      const text = (reply.output?.message?.content ?? []).map((block) => block.text ?? "").join("").trim();
      if (reply.stopReason === "content_filtered" || reply.stopReason === "guardrail_intervened") throw new Error(`the model declined: ${reply.stopReason}`);
      if (text === "") throw new Error(`the model wrote no text: ${reply.stopReason ?? "unknown"}`);
      return { text, usage: { inputTokens: reply.usage?.inputTokens ?? 0, outputTokens: reply.usage?.outputTokens ?? 0 } };
    },
  };
}
