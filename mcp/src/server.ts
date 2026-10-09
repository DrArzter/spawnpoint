#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { SpawnpointClient } from "./client.js";

const gameId = z.string().min(1).max(64).describe("Game ID from get_control_plane, for example minecraft");
const worldId = z.string().min(1).max(255).describe("World ID from get_control_plane");
const presetId = z.string().min(1).max(64).describe("Preset ID from get_control_plane");
const version = z.string().min(1).max(32).describe("Release version from get_control_plane, for example 1.2");

function releasePath(game: string, preset: string, release: string): string {
  return `/games/${encodeURIComponent(game)}/presets/${encodeURIComponent(preset)}/releases/${encodeURIComponent(release)}`;
}

function result(data: unknown) {
  return {
    structuredContent: { data },
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
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

  server.registerTool("get_profile", {
  title: "Get Spawnpoint profile",
  description: "Read the connected Spawnpoint identity and role.",
  inputSchema: {},
  outputSchema: { data: z.unknown() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => result(await client.request("/me")));

  server.registerTool("get_control_plane", {
  title: "Get Spawnpoint control plane",
  description: "List games, worlds, sessions, hosts, releases, permissions, and their current state. Call this before a world action.",
  inputSchema: {},
  outputSchema: { data: z.unknown() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => result(await client.request("/control-plane")));

  server.registerTool("get_host_metrics", {
  title: "Get host metrics",
  description: "Read recent metrics for one host shown by get_control_plane.",
  inputSchema: {
    instanceId: z.string().min(1).max(128).describe("Host instance ID"),
    range: z.enum(["1h", "6h", "24h", "7d"]).default("24h"),
  },
  outputSchema: { data: z.unknown() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ instanceId, range }) => result(await client.request(`/hosts/${encodeURIComponent(instanceId)}/metrics?range=${range}`)));

  server.registerTool("list_world_backups", {
  title: "List world backups",
  description: "List recoverable backups for one Spawnpoint world.",
  inputSchema: { gameId, worldId },
  outputSchema: { data: z.unknown() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ gameId, worldId }) => result(await client.request(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/backups`)));

  server.registerTool("get_world_pack", {
  title: "Get world client pack",
  description: "Create a temporary download link for the client pack used by the world's active release.",
  inputSchema: { gameId, worldId },
  outputSchema: { data: z.unknown() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ gameId, worldId }) => result(await client.request(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/pack`)));

  server.registerTool("get_release", {
  title: "Get release",
  description: "Read one release: its loader, runtime, source preset and server mods with their SHA-256 digests.",
  inputSchema: { gameId, presetId, version },
  outputSchema: { data: z.unknown() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ gameId, presetId, version }) => result(await client.request(releasePath(gameId, presetId, version))));

  server.registerTool("get_release_mod_link", {
  title: "Get release mod link",
  description: "Create a download link, valid for fifteen minutes, for one server mod of a release, named by its SHA-256 digest from get_release.",
  inputSchema: { gameId, presetId, version, sha256: z.string().regex(/^[0-9a-f]{64}$/).describe("The mod's SHA-256 digest from get_release") },
  outputSchema: { data: z.unknown() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ gameId, presetId, version, sha256 }) => result(await client.request(`${releasePath(gameId, presetId, version)}/mods/${sha256}`)));

  server.registerTool("get_backup_download_link", {
  title: "Get backup download link",
  description: "Create a download link, valid for five minutes, for one backup archive of a world, named by its key from list_world_backups. Who asked is recorded.",
  inputSchema: { gameId, worldId, key: z.string().min(1).max(512).describe("The archive's key from list_world_backups") },
  outputSchema: { data: z.unknown() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ gameId, worldId, key }) => result(await client.request(
    `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/backups/download`,
    { method: "POST", body: JSON.stringify({ key }) },
  )));

  server.registerTool("send_console_command", {
  title: "Send console command",
  description: "Send one console command to a running world, as the connected person. Commands that stop the game outside its lifecycle are refused. Returns the command's id; read its answer with get_console_result.",
  inputSchema: { gameId, worldId, command: z.string().min(1).max(256).describe("One line, as typed in the game's console") },
  outputSchema: { data: z.unknown() },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ gameId, worldId, command }) => result(await client.request(
    `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/console`,
    { method: "POST", body: JSON.stringify({ command }) },
  )));

  server.registerTool("get_console_result", {
  title: "Get console result",
  description: "Read the answer to one console command by the id send_console_command returned. Its status stays pending until the game answers.",
  inputSchema: { gameId, worldId, commandId: z.string().min(1).max(128).describe("The id send_console_command returned") },
  outputSchema: { data: z.unknown() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ gameId, worldId, commandId }) => {
    // The API answers a world's recent commands; this picks the one asked for.
    const history = await client.request(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/console`) as { entries?: { id?: unknown }[] };
    const entry = history.entries?.find((candidate) => candidate.id === commandId);
    return entry === undefined
      ? { ...result({ error: "unknown_command" }), isError: true }
      : result({ entry });
  });

  server.registerTool("start_world", {
  title: "Start world",
  description: "Request that Spawnpoint start one world. The returned operation is asynchronous; poll get_control_plane for completion.",
  inputSchema: { gameId, worldId },
  outputSchema: { data: z.unknown() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ gameId, worldId }) => result(await client.request(
    `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/start`,
    { method: "POST", body: "{}" },
  )));

  server.registerTool("stop_world", {
  title: "Stop world",
  description: "Request a verified backup and stop for one world. The returned operation is asynchronous; poll get_control_plane for completion.",
  inputSchema: { gameId, worldId },
  outputSchema: { data: z.unknown() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ gameId, worldId }) => result(await client.request(
    `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/stop`,
    { method: "POST", body: "{}" },
  )));

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer(new SpawnpointClient()).connect(new StdioServerTransport());
}
