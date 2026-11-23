import { ApiError } from "../contract";
import { request } from "./request";
import { demoEnabled } from "../../demo";
import { demoLatency } from "../../demo/flag";

const INVALID = "The connection request is no longer valid.";

export type OAuthAuthorizationSummary = Readonly<{
  client: { name: string; redirectOrigin: string };
  scopes: readonly string[];
}>;

export async function inspectOAuthAuthorization(authorizationRequest: string): Promise<OAuthAuthorizationSummary> {
  if (demoEnabled) {
    await demoLatency();
    return { client: { name: "Codex", redirectOrigin: "http://127.0.0.1" }, scopes: ["spawnpoint.read", "spawnpoint.operate"] };
  }
  return request<OAuthAuthorizationSummary>("/oauth/authorize/inspect", { method: "POST", body: { request: authorizationRequest }, failure: INVALID });
}

export async function decideOAuthAuthorization(authorizationRequest: string, approved: boolean): Promise<string> {
  if (demoEnabled) {
    await demoLatency();
    return `${window.location.origin}${window.location.pathname}?demo#/profile`;
  }
  const body = await request<{ redirect_to?: unknown }>("/oauth/authorize", { method: "POST", body: { request: authorizationRequest, approved }, failure: INVALID });
  if (typeof body.redirect_to !== "string") throw new ApiError("failed", "Spawnpoint did not return to the requesting app.");
  return body.redirect_to;
}
