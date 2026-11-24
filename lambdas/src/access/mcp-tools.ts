import type { Permission } from "./domain.ts";
import type { OAuthScope } from "./oauth.ts";
import { METRIC_RANGE_NAMES } from "../control-plane/metric-ranges.ts";

/*
 * The remote MCP tool contract (ADR-0061). This file is the one place that
 * declares tool names, descriptions and input schemas. The local stdio adapter
 * in mcp/ reads mcp/src/tools.generated.json, which scripts/export-mcp-tools.ts
 * writes from here; a test fails when the file is stale. The scope
 * caps what a client may ask for; the permission is checked on the Identity
 * at every call, as the web console checks it.
 */

const id = (description: string) => ({ type: "string", minLength: 1, description }) as const;
const gameId = id("Game ID from get_control_plane, for example minecraft");
const worldId = id("World ID from get_control_plane");
const presetId = id("Preset ID from get_control_plane");
const version = id("Release version from get_control_plane, for example 1.2");

function objectSchema(properties: Record<string, unknown>, required: readonly string[] = Object.keys(properties)): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const world = objectSchema({ gameId, worldId });
const release = objectSchema({ gameId, presetId, version });

export const mcpTools = [
  { name: "get_profile", title: "Get Spawnpoint profile", description: "Read the connected Spawnpoint identity and role.", permission: null, scope: "spawnpoint.read", inputSchema: objectSchema({}), readOnly: true, destructive: false },
  { name: "get_control_plane", title: "Get Spawnpoint control plane", description: "List games, worlds, sessions, hosts, releases, permissions, and their current state. Call this before a world action.", permission: "status.read", scope: "spawnpoint.read", inputSchema: objectSchema({}), readOnly: true, destructive: false },
  { name: "get_host_metrics", title: "Get host metrics", description: "Read recent metrics for one host shown by get_control_plane. Name it by hostId.", permission: "metrics.read", scope: "spawnpoint.read", inputSchema: objectSchema({ hostId: id("Host ID from get_control_plane"), instanceId: id("The old name of hostId: give hostId instead"), range: { type: "string", enum: [...METRIC_RANGE_NAMES], default: "24h" } }, []), readOnly: true, destructive: false },
  { name: "list_world_backups", title: "List world backups", description: "List recoverable backups for one Spawnpoint world.", permission: "backup.read", scope: "spawnpoint.read", inputSchema: world, readOnly: true, destructive: false },
  { name: "get_world_pack", title: "Get world client pack", description: "Create a temporary download link for the client pack used by the world's active release.", permission: "connection.read", scope: "spawnpoint.read", inputSchema: world, readOnly: true, destructive: false },
  // ADR-0065: a release's mods, listed with their SHA-256 digests, and one
  // mod's link by its digest; the players' own set too (ADR-0069).
  { name: "get_release", title: "Get release", description: "Read one release: its loader, runtime, source preset, server mods and, when players install a different set, the players' mods, each with its SHA-256 digest.", permission: "release.read", scope: "spawnpoint.read", inputSchema: release, readOnly: true, destructive: false },
  { name: "get_release_mod_link", title: "Get release mod link", description: "Create a download link, valid for fifteen minutes, for one mod of a release, server or players', named by its SHA-256 digest from get_release.", permission: "release.read", scope: "spawnpoint.read", inputSchema: objectSchema({ gameId, presetId, version, sha256: { type: "string", pattern: "^[0-9a-f]{64}$", description: "The mod's SHA-256 digest from get_release" } }), readOnly: true, destructive: false },
  // A whole save, under its own permission. The download is recorded against
  // the Identity; it changes no world, so it is a read.
  { name: "get_backup_download_link", title: "Get backup download link", description: "Create a download link, valid for five minutes, for one backup archive of a world, named by its key from list_world_backups. Who asked is recorded.", permission: "backup.download", scope: "spawnpoint.read", inputSchema: objectSchema({ gameId, worldId, key: id("The archive's key from list_world_backups") }), readOnly: true, destructive: false },
  // ADR-0063, amended: the console, as the connected person, under the same
  // permission and refusals as the panel. The client asks before each call;
  // the record names the client as well as the person.
  { name: "send_console_command", title: "Send console command", description: "Send one console command to a running world, as the connected person. Commands that stop the game outside its lifecycle are refused. The command is recorded with the person's and this client's names. Returns the command's id; read its answer with get_console_result.", permission: "console.use", scope: "spawnpoint.operate", inputSchema: objectSchema({ gameId, worldId, command: id("One line, as typed in the game's console") }), readOnly: false, destructive: true },
  { name: "get_console_result", title: "Get console result", description: "Read the answer to one console command by the id send_console_command returned. Its status stays pending until the game answers.", permission: "console.use", scope: "spawnpoint.read", inputSchema: objectSchema({ gameId, worldId, commandId: id("The id send_console_command returned") }), readOnly: true, destructive: false },
  { name: "start_world", title: "Start world", description: "Request that Spawnpoint start one world. The returned operation is asynchronous; poll get_control_plane for completion.", permission: "session.start", scope: "spawnpoint.operate", inputSchema: world, readOnly: false, destructive: false },
  { name: "stop_world", title: "Stop world", description: "Request a verified backup and stop for one world. The returned operation is asynchronous; poll get_control_plane for completion.", permission: "session.stop", scope: "spawnpoint.operate", inputSchema: world, readOnly: false, destructive: false },
] as const satisfies readonly { name: string; title: string; description: string; permission: Permission | null; scope: OAuthScope; inputSchema: Record<string, unknown>; readOnly: boolean; destructive: boolean }[];

/** What the local stdio adapter needs of each tool: no permission or scope data. */
export function localMcpToolsJson(): string {
  const tools = mcpTools.map(({ name, title, description, inputSchema, readOnly, destructive }) => ({ name, title, description, readOnly, destructive, inputSchema }));
  return `${JSON.stringify(tools, null, 2)}\n`;
}

export type McpToolName = (typeof mcpTools)[number]["name"];
