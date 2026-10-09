import type { Permission } from "./domain.ts";
import type { OAuthScope } from "./oauth.ts";

/*
 * The remote MCP tool contract (ADR-0061). The local stdio adapter in mcp/
 * registers the same names; a test holds the two lists together. The scope
 * caps what a client may ask for; the permission is checked on the Identity
 * at every call, as the web console checks it.
 */

const text = { type: "string" } as const;

function objectSchema(properties: Record<string, unknown>, required: readonly string[] = Object.keys(properties)): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const world = objectSchema({ gameId: text, worldId: text });
const release = objectSchema({ gameId: text, presetId: text, version: text });

export const mcpTools = [
  { name: "get_profile", title: "Get Spawnpoint profile", description: "Read the connected Spawnpoint identity and role.", permission: null, scope: "spawnpoint.read", inputSchema: objectSchema({}), readOnly: true, destructive: false },
  { name: "get_control_plane", title: "Get Spawnpoint control plane", description: "List games, worlds, sessions, hosts, releases, permissions, and current state.", permission: "status.read", scope: "spawnpoint.read", inputSchema: objectSchema({}), readOnly: true, destructive: false },
  { name: "get_host_metrics", title: "Get host metrics", description: "Read recent metrics for one host.", permission: "metrics.read", scope: "spawnpoint.read", inputSchema: objectSchema({ instanceId: text, range: { type: "string", enum: ["1h", "6h", "24h", "7d"], default: "24h" } }, ["instanceId"]), readOnly: true, destructive: false },
  { name: "list_world_backups", title: "List world backups", description: "List recoverable backups for one world.", permission: "backup.read", scope: "spawnpoint.read", inputSchema: world, readOnly: true, destructive: false },
  { name: "get_world_pack", title: "Get world client pack", description: "Create a temporary download link for the world's client pack.", permission: "connection.read", scope: "spawnpoint.read", inputSchema: world, readOnly: true, destructive: false },
  // ADR-0065: a release's server mods, listed with their SHA-256 digests, and
  // one mod's link by its digest.
  { name: "get_release", title: "Get release", description: "Read one release: its loader, runtime, source preset and server mods with their SHA-256 digests.", permission: "release.read", scope: "spawnpoint.read", inputSchema: release, readOnly: true, destructive: false },
  { name: "get_release_mod_link", title: "Get release mod link", description: "Create a download link, valid for fifteen minutes, for one server mod of a release, named by its SHA-256 digest from get_release.", permission: "release.read", scope: "spawnpoint.read", inputSchema: objectSchema({ gameId: text, presetId: text, version: text, sha256: text }), readOnly: true, destructive: false },
  // A whole save, under its own permission. The download is recorded against
  // the Identity; it changes no world, so it is a read.
  { name: "get_backup_download_link", title: "Get backup download link", description: "Create a download link, valid for five minutes, for one backup archive of a world, named by its key from list_world_backups. Who asked is recorded.", permission: "backup.download", scope: "spawnpoint.read", inputSchema: objectSchema({ gameId: text, worldId: text, key: text }), readOnly: true, destructive: false },
  // ADR-0063, amended: the console, as the connected person, under the same
  // permission and refusals as the panel. The client asks before each call;
  // the record names the client as well as the person.
  { name: "send_console_command", title: "Send console command", description: "Send one console command to a running world, as the connected person. Commands that stop the game outside its lifecycle are refused. The command is recorded with the person's and this client's names. Returns the command's id; read its answer with get_console_result.", permission: "console.use", scope: "spawnpoint.operate", inputSchema: objectSchema({ gameId: text, worldId: text, command: text }), readOnly: false, destructive: true },
  { name: "get_console_result", title: "Get console result", description: "Read the answer to one console command by the id send_console_command returned. Its status stays pending until the game answers.", permission: "console.use", scope: "spawnpoint.read", inputSchema: objectSchema({ gameId: text, worldId: text, commandId: text }), readOnly: true, destructive: false },
  { name: "start_world", title: "Start world", description: "Request that Spawnpoint start one world.", permission: "session.start", scope: "spawnpoint.operate", inputSchema: world, readOnly: false, destructive: false },
  { name: "stop_world", title: "Stop world", description: "Request a verified backup and stop for one world.", permission: "session.stop", scope: "spawnpoint.operate", inputSchema: world, readOnly: false, destructive: false },
] as const satisfies readonly { name: string; title: string; description: string; permission: Permission | null; scope: OAuthScope; inputSchema: Record<string, unknown>; readOnly: boolean; destructive: boolean }[];

export type McpToolName = (typeof mcpTools)[number]["name"];
