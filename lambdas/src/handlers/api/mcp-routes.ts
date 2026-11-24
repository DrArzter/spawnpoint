import { publicRoute, type Route } from "./routing.ts";
import { type McpCatalogue, remoteMcp } from "./mcp.ts";

/** The remote MCP endpoint. The catalogue is read at a request, from the route table that holds this route. */
export function mcpRoutes(catalogue: () => McpCatalogue): Readonly<Record<string, Route>> {
  return { "POST /mcp": publicRoute((event) => remoteMcp(event, catalogue())) };
}
