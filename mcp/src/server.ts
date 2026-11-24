#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { SpawnpointClient } from "./client.js";
import tools from "./tools.generated.json" with { type: "json" };

type Args = Record<string, string>;
type Call = (client: SpawnpointClient, args: Args) => Promise<unknown>;

const world = (args: Args) => `/games/${encodeURIComponent(args.gameId!)}/worlds/${encodeURIComponent(args.worldId!)}`;
const release = (args: Args) => `/games/${encodeURIComponent(args.gameId!)}/presets/${encodeURIComponent(args.presetId!)}/releases/${encodeURIComponent(args.version!)}`;
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

// The API call each tool makes. Names and schemas come from tools.generated.json.
export const toolCalls: Readonly<Record<string, Call>> = {
  get_profile: (client) => client.request("/me"),
  get_control_plane: (client) => client.request("/control-plane"),
  get_host_metrics: (client, args) => client.request(`/hosts/${encodeURIComponent(args.instanceId!)}/metrics?range=${args.range}`),
  list_world_backups: (client, args) => client.request(`${world(args)}/backups`),
  get_world_pack: (client, args) => client.request(`${world(args)}/pack`),
  get_release: (client, args) => client.request(release(args)),
  get_release_mod_link: (client, args) => client.request(`${release(args)}/mods/${args.sha256}`),
  get_backup_download_link: (client, args) => client.request(`${world(args)}/backups/download`, post({ key: args.key })),
  send_console_command: (client, args) => client.request(`${world(args)}/console`, post({ command: args.command })),
  // The API answers a world's recent commands; this picks the one asked for.
  get_console_result: async (client, args) => {
    const history = await client.request(`${world(args)}/console`) as { entries?: { id?: unknown }[] };
    const entry = history.entries?.find((candidate) => candidate.id === args.commandId);
    return entry === undefined ? { error: "unknown_command" } : { entry };
  },
  start_world: (client, args) => client.request(`${world(args)}/start`, { method: "POST", body: "{}" }),
  stop_world: (client, args) => client.request(`${world(args)}/stop`, { method: "POST", body: "{}" }),
};

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

  for (const tool of tools) {
    const call = toolCalls[tool.name];
    if (call === undefined) throw new Error(`No API call for tool ${tool.name}`);
    // The schema is built from the shared JSON, so it is never typed again here.
    const schema = z.fromJSONSchema(tool.inputSchema as z.core.JSONSchema.JSONSchema) as z.ZodObject;
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: schema.shape,
      outputSchema: { data: z.unknown() },
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, openWorldHint: false },
    }, async (args: Args) => {
      const data = await call(client, args);
      return result(data, (data as { error?: unknown } | null)?.error === "unknown_command");
    });
  }

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer(new SpawnpointClient()).connect(new StdioServerTransport());
}
