import { publicRoute, type Route } from "./routing.ts";
import { remoteMcp } from "./mcp.ts";

export const mcpRoutes: Readonly<Record<string, Route>> = {
  "POST /mcp": publicRoute((event) => remoteMcp(event))
};
