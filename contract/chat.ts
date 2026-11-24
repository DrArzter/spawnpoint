// A chat surface asks the API to run one of its own routes for a person
// (ADR-0087). The chat names who asked by the login account it verified; the
// API resolves the identity and checks the route's permission itself.

export const CHAT_REQUEST_KIND = "spawnpoint.chat-request";

/** The routes a chat may run. Each keeps the authority the route table declares. */
export const CHAT_ROUTES = ["POST /games/{gameId}/worlds/{worldId}/start"] as const;

export type ChatRoute = (typeof CHAT_ROUTES)[number];

export type ChatRequest = Readonly<{
  kind: typeof CHAT_REQUEST_KIND;
  /** The login account the chat verified, as a login provider names it. */
  account: Readonly<{ provider: "telegram"; subject: string }>;
  routeKey: ChatRoute;
  pathParameters: Readonly<Record<string, string>>;
  body?: string;
}>;

/** The API's answer, as the route gives it to a browser. */
export type ChatReply = Readonly<{ statusCode: number; body: string }>;
