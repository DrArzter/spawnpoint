import { type Identity } from "../../access/domain.ts";
import { isAssistantModel, MAX_ASSISTANT_QUESTION_LENGTH } from "../../../../contract/assistant.ts";
import {
  ASSISTANT_DAILY_LIMIT, type AssistantAnswer, type AssistantAnswers, type AssistantBudget, type AssistantConfig, type AssistantWorker, utcDay, utcMonth,
} from "../../control-plane/assistant.ts";
import { type WorldLogRead } from "../../control-plane/world-log.ts";
import { type JsonObject, type Response, response, parseJsonObject, errorResponse } from "./http.ts";

// --- The owner's log assistant (ADR-0094) ---------------------------------------
// The API checks the request and the limits, records the question and hands
// the redacted log to the worker, which asks the model. Nothing waits on it.

export type AssistantDependencies = Readonly<{
  config: Pick<AssistantConfig, "enabled" | "monthlyCapUsd">;
  /** A log read of the world, redacted, as the log feature answers it. */
  logRead: (gameId: string, worldId: string, readId: string) => Promise<WorldLogRead | null>;
  gameName: (gameId: string) => string | null;
  answers: AssistantAnswers;
  budget: AssistantBudget;
  worker: AssistantWorker;
  newId: () => string;
  now: () => Date;
}>;

export type AssistantFeature = Readonly<{
  ask: (identity: Identity, gameId: string, worldId: string, body: string | undefined) => Promise<Response>;
  answer: (gameId: string, worldId: string, answerId: string) => Promise<Response>;
}>;

type Question = Readonly<{ logReadId: string; model: AssistantAnswer["model"]; question: string | null }>;

function parseQuestion(parsed: JsonObject): Question | null {
  const { logReadId, model, question } = parsed;
  if (typeof logReadId !== "string" || logReadId === "" || logReadId.length > 64 || !isAssistantModel(model)) return null;
  if (question === undefined || question === null) return { logReadId, model, question: null };
  if (typeof question !== "string") return null;
  const text = question.trim();
  // A question is text, with its own line breaks, and no other control characters.
  if (text.length > MAX_ASSISTANT_QUESTION_LENGTH || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) return null;
  return { logReadId, model, question: text === "" ? null : text };
}

export function assistantFeature(dependencies: AssistantDependencies): AssistantFeature {
  const { config, logRead, gameName, answers, budget, worker, newId, now } = dependencies;

  return {
    async ask(identity, gameId, worldId, body) {
      const parsed = parseJsonObject({ body });
      if (!config.enabled) return errorResponse(409, "assistant_disabled");
      const asked = parseQuestion(parsed);
      if (asked === null) return errorResponse(400, "invalid_assistant_request");
      const name = gameName(gameId);
      if (name === null) return errorResponse(404, "unknown_world");
      const read = await logRead(gameId, worldId, asked.logReadId);
      if (read === null) return errorResponse(404, "unknown_log_read");
      if (read.status !== "succeeded" || read.lines === null) return errorResponse(409, "log_not_ready");

      const at = now();
      // The month's cap is checked before the day is counted, so a refusal for
      // the month does not use up one of the day's questions.
      if (await budget.monthlySpend(utcMonth(at)) >= config.monthlyCapUsd * 1_000_000) return errorResponse(429, "assistant_monthly_limit");
      if (!await budget.claimDailyUse(identity.id, utcDay(at), ASSISTANT_DAILY_LIMIT)) return errorResponse(429, "assistant_daily_limit");

      const answer: AssistantAnswer = {
        id: newId(), at: at.toISOString(), logReadId: read.id, model: asked.model, question: asked.question, status: "pending", text: null,
      };
      await answers.create({ answer, gameId, worldId, identityId: identity.id });
      try {
        await worker.start({ worldId, answerId: answer.id, model: asked.model, gameName: name, lines: read.lines, question: asked.question });
      } catch (error) {
        await answers.settle(worldId, answer.id, { status: "failed" });
        throw error;
      }
      return response(202, { answer });
    },
    async answer(gameId, worldId, answerId) {
      const found = await answers.find(gameId, worldId, answerId);
      return found === null ? errorResponse(404, "unknown_assistant_answer") : response(200, { answer: found });
    },
  };
}
