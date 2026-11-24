import { type BedrockRuntimeClient, type ContentBlock, ConverseCommand, type ToolUseBlock } from "@aws-sdk/client-bedrock-runtime";

import type { AssistantModelPort } from "./assistant.ts";
import type { Block, ConversePort } from "./assistant-conversation.ts";

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

// --- The conversation's tool loop (ADR-0096) -------------------------------------

type SdkBlock = ContentBlock;
/** A JSON document as the SDK types it. */
type DocumentType = NonNullable<ToolUseBlock["input"]>;

function toSdk(block: Block): SdkBlock {
  if ("text" in block) return { text: block.text };
  if ("toolUse" in block) return { toolUse: { toolUseId: block.toolUse.toolUseId, name: block.toolUse.name, input: block.toolUse.input as DocumentType } };
  if ("toolResult" in block) {
    return { toolResult: { toolUseId: block.toolResult.toolUseId, content: [{ text: block.toolResult.text }], status: block.toolResult.ok ? "success" : "error" } };
  }
  const { text, signature, redacted } = block.reasoning;
  return redacted === undefined
    ? { reasoningContent: { reasoningText: { text: text ?? "", ...(signature === undefined ? {} : { signature }) } } }
    : { reasoningContent: { redactedContent: Buffer.from(redacted, "base64") } };
}

function fromSdk(block: SdkBlock): Block | null {
  if (block.text !== undefined) return { text: block.text };
  if (block.toolUse !== undefined) return { toolUse: { toolUseId: block.toolUse.toolUseId ?? "", name: block.toolUse.name ?? "", input: block.toolUse.input ?? {} } };
  const reasoning = block.reasoningContent;
  if (reasoning?.reasoningText !== undefined) {
    const { text, signature } = reasoning.reasoningText;
    return { reasoning: { text: text ?? "", ...(signature === undefined ? {} : { signature }) } };
  }
  if (reasoning?.redactedContent !== undefined) return { reasoning: { redacted: Buffer.from(reasoning.redactedContent).toString("base64") } };
  return null;
}

/**
 * The conversation's model over Converse, with the catalogue's tools. The
 * model's reasoning comes back as blocks that are kept and sent back as they
 * were, which a model that thinks between tool calls requires.
 */
export function bedrockConverse(client: Pick<BedrockRuntimeClient, "send">): ConversePort {
  return {
    converse: async ({ modelId, system, messages, tools, maxTokens }) => {
      const reply = await client.send(new ConverseCommand({
        modelId,
        system: [{ text: system }],
        messages: messages.map((message) => ({ role: message.role, content: message.content.map(toSdk) })),
        toolConfig: { tools: tools.map((tool) => ({ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.inputSchema as DocumentType } } })) },
        inferenceConfig: { maxTokens },
      }));
      if (reply.stopReason === "content_filtered" || reply.stopReason === "guardrail_intervened") throw new Error(`the model declined: ${reply.stopReason}`);
      const content = (reply.output?.message?.content ?? []).map(fromSdk).filter((block): block is Block => block !== null);
      return {
        content,
        stopReason: reply.stopReason ?? "end_turn",
        usage: { inputTokens: reply.usage?.inputTokens ?? 0, outputTokens: reply.usage?.outputTokens ?? 0 },
      };
    },
  };
}
