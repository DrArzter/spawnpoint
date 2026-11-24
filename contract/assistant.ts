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
