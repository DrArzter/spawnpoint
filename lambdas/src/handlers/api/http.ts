import { type LoginPrincipal } from "../../access/login-session.ts";
import { requestBody } from "../../access/request-body.ts";

import type { ApiErrorCode } from "../../../../contract/errors.ts";

export type Event = Readonly<{
  requestContext?: { http?: { method?: string } };
  routeKey?: string;
  rawPath?: string;
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
}>;

export type Response = Readonly<{ statusCode: number; headers: Record<string, string>; body: string; cookies?: string[] }>;

export type Caller = LoginPrincipal;

export function response(statusCode: number, body: unknown): Response {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8" }, body: body === null ? "" : JSON.stringify(body) };
}

/** A refusal with a code the contract declares (contract/errors.ts). `detail` names what was refused. */
export function errorResponse(statusCode: number, error: ApiErrorCode, detail: Readonly<Record<string, unknown>> = {}): Response {
  return response(statusCode, { ...detail, error });
}

export function responseWithHeaders(statusCode: number, body: unknown, headers: Record<string, string>): Response {
  const base = response(statusCode, body);
  return { ...base, headers: { ...base.headers, ...headers } };
}

export function responseWithCookies(statusCode: number, body: unknown, cookies: string[]): Response {
  return { ...response(statusCode, body), cookies };
}

export function requestCookie(event: Event, name: string): string | null {
  const values = event.cookies ?? Object.entries(event.headers ?? {})
    .filter(([key]) => key.toLowerCase() === "cookie")
    .flatMap(([, value]) => value?.split(";") ?? []);
  for (const value of values) {
    const [cookieName, ...parts] = value.trim().split("=");
    if (cookieName === name) return parts.join("=");
  }
  return null;
}

export type JsonObject = Readonly<Record<string, unknown>>;

// A request body that is not one JSON object. The dispatcher turns it into 400.
export class InvalidBodyError extends Error {
  constructor() {
    super("invalid_json");
    this.name = "InvalidBodyError";
  }
}

// The only place under handlers/api that parses text as JSON. It throws on bad syntax.
export function parseJsonText(text: string): unknown {
  return JSON.parse(text) as unknown;
}

// The one request-body parser. An empty body is an empty object. Any other
// value that is not a plain object (null, array, number, string) or any
// invalid JSON throws InvalidBodyError.
export function parseJsonObject(event: Readonly<{ body?: string | undefined; isBase64Encoded?: boolean | undefined }>): JsonObject {
  const text = requestBody(event);
  if (text === "") return {};
  let parsed: unknown;
  try {
    parsed = parseJsonText(text);
  } catch {
    throw new InvalidBodyError();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidBodyError();
  return parsed as JsonObject;
}

export const parameter = (event: Event, name: string): string => event.pathParameters?.[name] ?? "";
