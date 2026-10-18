import { sessionRoute, type Route } from "./routing.ts";
import { session, requestAccess } from "./session.ts";
import { observe } from "./identity-store.ts";

export function sessionRoutes(getCapabilities: () => readonly string[]): Readonly<Record<string, Route>> {
  return {
    "GET /session": sessionRoute((account) => session(account, getCapabilities())),
    "POST /access/request": sessionRoute(async (account) => {
      await observe(account);
      return requestAccess(account);
    }),
  };
}
