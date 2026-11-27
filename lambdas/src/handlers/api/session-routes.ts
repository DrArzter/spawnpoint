import { sessionRoute, type Route } from "./routing.ts";
import { session, requestAccess, type SessionFlags } from "./session.ts";
import { observe } from "./identity-store.ts";

export function sessionRoutes(getFlags: () => Promise<SessionFlags>): Readonly<Record<string, Route>> {
  return {
    "GET /session": sessionRoute(async (account) => session(account, await getFlags())),
    "POST /access/request": sessionRoute(async (account) => {
      await observe(account);
      return requestAccess(account);
    }),
  };
}
