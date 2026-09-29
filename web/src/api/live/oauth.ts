import { authorizedFetch } from "./transport";
import { demoEnabled } from "../../demo";
import { demoLatency } from "../../demo/flag";

export type OAuthAuthorizationSummary = Readonly<{
  client: { name: string; redirectOrigin: string };
  scopes: readonly string[];
}>;

async function parsed(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "The connection request is no longer valid.");
  return body ?? {};
}

export async function inspectOAuthAuthorization(request: string): Promise<OAuthAuthorizationSummary> {
  if (demoEnabled) {
    await demoLatency();
    return { client: { name: "Codex", redirectOrigin: "http://127.0.0.1" }, scopes: ["spawnpoint.read", "spawnpoint.operate"] };
  }
  const response = await authorizedFetch("/oauth/authorize/inspect", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request }),
  });
  return await parsed(response) as OAuthAuthorizationSummary;
}

export async function decideOAuthAuthorization(request: string, approved: boolean): Promise<string> {
  if (demoEnabled) {
    await demoLatency();
    return `${window.location.origin}${window.location.pathname}?demo#/profile`;
  }
  const response = await authorizedFetch("/oauth/authorize", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request, approved }),
  });
  const body = await parsed(response);
  if (typeof body.redirect_to !== "string") throw new Error("Spawnpoint did not return to the requesting app.");
  return body.redirect_to;
}
