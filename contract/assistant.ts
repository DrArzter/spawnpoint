// The owner's log assistant (ADR-0094), as the API answers it.

export const ASSISTANT_MODELS = ["haiku", "sonnet"] as const;
export type AssistantModel = typeof ASSISTANT_MODELS[number];

export const MAX_ASSISTANT_QUESTION_LENGTH = 500;

export type AssistantStatus = "pending" | "succeeded" | "failed";

export type AssistantAnswer = Readonly<{
  id: string;
  at: string;
  /** The log read the answer explains. */
  logReadId: string;
  model: AssistantModel;
  question: string | null;
  status: AssistantStatus;
  /** The model's answer; null until it is written, or when it failed. */
  text: string | null;
}>;

export function isAssistantModel(value: unknown): value is AssistantModel {
  return typeof value === "string" && (ASSISTANT_MODELS as readonly string[]).includes(value);
}

// --- Conversations with the assistant (ADR-0096) --------------------------------

export const MAX_ASSISTANT_MESSAGE_LENGTH = 4000;

/** working: the model is busy; waiting: proposals wait for the owner; idle: the owner's turn; failed: the last turn stopped. */
export type ConversationStatus = "working" | "waiting" | "idle" | "failed";

export type ProposalStatus = "pending" | "applied" | "rejected" | "failed";

/** A change the model asked for. It runs only when the owner applies it. */
export type AssistantProposal = Readonly<{
  id: string;
  /** The tool's name and title, as the catalogue declares them (ADR-0095). */
  tool: string;
  title: string;
  destructive: boolean;
  /** The arguments the model gave, as JSON. */
  arguments: Readonly<Record<string, unknown>>;
  status: ProposalStatus;
  /** What the route answered once applied, cut to a readable length. */
  result: string | null;
  decidedAt: string | null;
}>;

/** One line of a conversation as the panel shows it. */
export type ConversationEntry =
  | Readonly<{ kind: "owner"; text: string }>
  | Readonly<{ kind: "assistant"; text: string }>
  | Readonly<{ kind: "read"; tool: string; title: string; ok: boolean }>
  | Readonly<{ kind: "proposal"; proposal: AssistantProposal }>;

export type ConversationSummary = Readonly<{
  id: string;
  title: string;
  model: AssistantModel;
  status: ConversationStatus;
  updatedAt: string;
}>;

export type AssistantConversation = ConversationSummary & Readonly<{
  entries: readonly ConversationEntry[];
  /** Why the last turn stopped, when it failed or reached its limit. */
  note: string | null;
}>;

/** A read the worker asks the API to run as the owner (ADR-0096). Only a direct Lambda invocation takes this shape. */
export const ASSISTANT_TOOL_REQUEST_KIND = "spawnpoint.assistant-tool";

export type AssistantToolRequest = Readonly<{
  kind: typeof ASSISTANT_TOOL_REQUEST_KIND;
  identityId: string;
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
}>;
