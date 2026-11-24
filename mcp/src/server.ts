#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { SpawnpointClient } from "./client.js";
import tools from "./tools.generated.json" with { type: "json" };

type Args = Record<string, unknown>;
type Tool = (typeof tools)[number] & { route: string; pathNames?: Record<string, string> };

/**
 * The API call a tool makes, from its route (ADR-0095): the path's parameters
 * from the arguments, and the rest as a POST or PUT body or a GET query.
 */
export function apiCall(tool: Pick<Tool, "route" | "pathNames">, args: Args): Readonly<{ path: string; init?: RequestInit }> {
  const [method = "GET", template = "/"] = tool.route.split(" ");
  const used = new Set<string>();
  const path = template.replaceAll(/\{([A-Za-z0-9]+)\}/g, (_match, parameter: string) => {
    const name = tool.pathNames?.[parameter] ?? parameter;
    used.add(name).add(parameter);
    return encodeURIComponent(String(args[name] ?? args[parameter] ?? ""));
  });
  const rest = Object.fromEntries(Object.entries(args).filter(([name, value]) => !used.has(name) && value !== undefined));
  if (method === "POST" || method === "PUT") return { path, init: { method, body: JSON.stringify(rest) } };
  const query = new URLSearchParams(Object.entries(rest).map(([name, value]) => [name, typeof value === "string" ? value : JSON.stringify(value)]));
  const withQuery = query.size > 0 ? `${path}?${query}` : path;
  return method === "GET" ? { path: withQuery } : { path: withQuery, init: { method } };
}

function result(data: unknown, isError: boolean) {
  return {
    structuredContent: { data },
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError } : {}),
  };
}

export function createServer(client: SpawnpointClient): McpServer {
  const server = new McpServer(
    { name: "spawnpoint", version: "0.1.0" },
    {
      instructions:
        "Use get_control_plane before changing a world so IDs and current state are fresh. " +
        "Spawnpoint enforces the connected identity's permissions. Never claim an operation finished merely because it was accepted.",
    },
  );

  for (const tool of tools as readonly Tool[]) {
    // The schema is built from the shared JSON, so it is never typed again here.
    const schema = z.fromJSONSchema(tool.inputSchema as z.core.JSONSchema.JSONSchema) as z.ZodObject;
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: schema.shape,
      outputSchema: { data: z.unknown() },
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, openWorldHint: false },
    }, async (args: Args) => {
      const call = apiCall(tool, args);
      try {
        return result(await client.request(call.path, call.init), false);
      } catch (error) {
        return result({ error: error instanceof Error ? error.message : String(error) }, true);
      }
    });
  }

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer(new SpawnpointClient()).connect(new StdioServerTransport());
}
