import { apiFailure, ApiError, errorCode, type ApiErrorBody, type ApiErrorCode } from "../contract";
import { API_ERROR_TEXT, UNREACHABLE } from "../error-text";
import { authorizedFetch, sessionFetch } from "./transport";

type Refusal = string | ((detail: ApiErrorBody) => string);

export type RequestOptions<T> = Readonly<{
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Sent as JSON. */
  body?: unknown;
  /** False for a call that must not renew the browser session first: sign-in, the session probe, logout. */
  renew?: boolean;
  /** Text for a failure that has no code text. */
  failure: string;
  /** Text by error code for this call. The shared table (error-text.ts) words the rest. */
  refusals?: Readonly<Partial<Record<ApiErrorCode, Refusal>>>;
  /** Text by status and code, where the words depend on both (sign-in). Wins over `refusals`. */
  describe?: (status: number, code: ApiErrorCode | undefined) => string;
  /** An answer that is ok but lacks what the call needs is a failure. */
  valid?: (body: T) => boolean;
}>;

/**
 * Every live call goes through here. It returns the parsed body of an ok answer
 * and otherwise throws an ApiError: `status`, `code` (the body's `error`) and
 * `detail` (the body) say what the API sent, and `kind` says what the panel may
 * offer next. A network failure is `unavailable`.
 */
export async function request<T>(path: string, options: RequestOptions<T>): Promise<T> {
  let response: Response;
  try {
    const init: RequestInit = {
      method: options.method ?? "GET",
      ...(options.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body) }),
    };
    response = await (options.renew === false ? sessionFetch(path, init) : authorizedFetch(path, init));
  } catch {
    throw new ApiError("unavailable", UNREACHABLE);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiErrorBody | null;
    throw await apiFailure(response, refusalText(response.status, body, options), body);
  }
  const text = await response.text().catch(() => "");
  let parsed: T;
  try {
    parsed = (text === "" ? undefined : JSON.parse(text)) as T;
  } catch {
    throw new ApiError("failed", options.failure, { status: response.status });
  }
  if (options.valid && !options.valid(parsed)) throw new ApiError("failed", options.failure, { status: response.status });
  return parsed;
}

/** `request`, except that an answer `absent` accepts is `null`: a world with no metrics yet, a release with no plan. */
export async function requestOrNull<T>(path: string, options: RequestOptions<T>, absent: (error: ApiError) => boolean): Promise<T | null> {
  try {
    return await request<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError && absent(error)) return null;
    throw error;
  }
}

function refusalText<T>(status: number, body: ApiErrorBody | null, options: RequestOptions<T>): string {
  const code = errorCode(body);
  if (options.describe) return options.describe(status, code ?? undefined);
  if (code === null) return options.failure;
  const refusal = options.refusals?.[code];
  if (typeof refusal === "function") return refusal(body ?? {});
  return refusal ?? API_ERROR_TEXT[code] ?? options.failure;
}
