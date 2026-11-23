import type { ApiFailureKind } from "../api/contract";

/**
 * How a failed load reads, whatever skin draws it. A role that lacks the
 * permission has nothing to retry, so it gets a title and no message. An API
 * that did not answer says so and keeps Retry. Anything else keeps its own
 * title, its message and Retry.
 */
export type FailureView = Readonly<{ kind: ApiFailureKind; title: string; message: string | null; retry: boolean }>;

export function failureView(kind: ApiFailureKind, title: string, verb: string, message: string): FailureView {
  if (kind === "forbidden") return { kind, title: `Your role cannot ${verb}`, message: null, retry: false };
  if (kind === "unavailable") return { kind, title: "Unavailable", message, retry: true };
  return { kind, title, message, retry: true };
}
