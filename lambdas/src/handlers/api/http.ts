import { type LoginPrincipal } from "../../access/login-session.ts";

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

export function objectBody(event: Event): Readonly<Record<string, unknown>> | null {
  return parseObjectBody(event.body);
}

export function parseObjectBody(body: string | undefined): Readonly<Record<string, unknown>> | null {
  try {
    const parsed = body ? JSON.parse(body) as unknown : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}

export const parameter = (event: Event, name: string): string => event.pathParameters?.[name] ?? "";
