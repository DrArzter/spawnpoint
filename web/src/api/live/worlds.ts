import type { ControlPlaneSnapshot, SettingValue, WorldGameSettings } from "../../model";
import { apiFailure, type FileLink, type ReleaseMod, type ReleaseMods, type SessionOperation, type SpawnpointApi, type WorldLifecycleAction } from "../contract";
import { authorizedFetch } from "./transport";

function controlPlaneSubscription(onInvalidated: () => void): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) return;
    const delay = Math.min(30_000, 1_000 * (2 ** reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const connect = async () => {
    try {
      const response = await authorizedFetch("/control-plane/subscriptions", { method: "POST" });
      if (!response.ok) throw new Error("Control-plane subscription was rejected.");
      const body = await response.json() as { url?: unknown; ticket?: unknown };
      if (typeof body.url !== "string" || !body.url.startsWith("wss://") || typeof body.ticket !== "string") {
        throw new Error("Control-plane subscription was invalid.");
      }
      const url = new URL(body.url);
      url.searchParams.set("ticket", body.ticket);
      if (closed) return;
      socket = new WebSocket(url);
      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        onInvalidated();
      });
      socket.addEventListener("message", (message) => {
        try {
          const value = JSON.parse(String(message.data)) as { type?: unknown };
          if (value.type === "control-plane-invalidated") onInvalidated();
        } catch {
          // The socket carries hints, never authority. Ignore malformed hints.
        }
      });
      socket.addEventListener("close", scheduleReconnect);
      socket.addEventListener("error", () => socket?.close());
    } catch {
      scheduleReconnect();
    }
  };

  void connect();
  return () => {
    closed = true;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    socket?.close();
  };
}

function worldLifecyclePayload(action: WorldLifecycleAction, worldId: string, backupKey?: string, release?: string): Record<string, string | undefined> {
  if (action === "restore") return { backupKey };
  if (action === "purge") return { confirmation: worldId };
  if (action === "regenerate") return { release };
  return {};
}

export const worldsApi = {
  async loadControlPlane(): Promise<ControlPlaneSnapshot> {
    const response = await authorizedFetch("/control-plane");
    if (!response.ok) throw await apiFailure(response, response.status === 403 ? "Your role cannot view server status." : "The control-plane state could not be loaded.");
    return response.json() as Promise<ControlPlaneSnapshot>;
  },

  subscribeControlPlane(onInvalidated: () => void): () => void {
    return controlPlaneSubscription(onInvalidated);
  },

  async requestSessionOperation(gameId: string, worldId: string, action: SessionOperation) {
    const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/${action}`, { method: "POST" });
    const body = await response.json() as { error?: string; result?: "requested" | "already_stopped"; operationId?: string };
    if (!response.ok) {
      const messages: Record<string, string> = {
        forbidden: `Your role cannot ${action} sessions.`,
        unsupported_world: "This world is not connected to a session workflow yet.",
        operation_in_progress: "Another control-plane operation is already running.",
        host_not_unique: "Spawnpoint could not select exactly one compatible host.",
        host_transitioning: "The compute host is already changing state. Refresh and try again shortly.",
        host_already_running: "The configured host is running another session. Stop it first, or move this world to the fleet.",
        session_transitioning: "This world's session is already starting, running or stopping.",
        world_not_active: "This world is not the one running. Refresh to see which is.",
        active_session_unavailable: "Spawnpoint has no session on record for this world.",
        fleet_unavailable: "This deployment does not launch fleet hosts.",
        configured_host_unavailable: "The configured host is not available.",
      };
      throw new Error(messages[body.error ?? ""] ?? `The ${action} request could not be accepted.`);
    }
    if (!body.result) throw new Error("Spawnpoint returned an invalid operation response.");
    return { result: body.result, ...(body.operationId ? { operationId: body.operationId } : {}) };
  },

  async requestWorldLifecycle(gameId: string, worldId: string, action: WorldLifecycleAction, backupKey?: string, release?: string) {
    const response = await authorizedFetch(
      `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/${action === "regenerate" ? "wipe" : action}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(worldLifecyclePayload(action, worldId, backupKey, release)) },
    );
    const body = await response.json() as { error?: string; result?: "requested"; operationId?: string };
    if (!response.ok || body.result !== "requested" || body.operationId === undefined) {
      const messages: Record<string, string> = {
        forbidden: "Your role cannot manage this world.",
        invalid_purge_confirmation: "Type the exact world ID before permanently deleting it.",
        world_not_archived: "Archive this world before permanently deleting it.",
        invalid_backup_key: "This backup does not belong to the selected world.",
        unknown_generation: "This backup no longer matches a wipe in this world.",
        release_missing: "The release required by this backup is missing. The world was not changed.",
        unknown_materialized_world: "Create this world with its first Start before managing its lifecycle.",
        operation_in_progress: "Another control-plane operation is already running.",
        host_not_unique: "Spawnpoint could not select exactly one compatible host.",
        host_transitioning: "The compute host is already changing state. Try again shortly.",
      };
      throw new Error(messages[body.error ?? ""] ?? `The ${action} request could not be accepted.`);
    }
    return { result: body.result, operationId: body.operationId };
  },

  async requestCreateWorld(gameId: string, presetId: string, displayName: string, release: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external") {
    const response = await authorizedFetch(
      `/games/${encodeURIComponent(gameId)}/presets/${encodeURIComponent(presetId)}/worlds`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName, release, placement, connectivity, ...(auth ? { auth } : {}) }) },
    );
    const body = await response.json() as { error?: string; world?: { id: string; displayName: string } };
    if (!response.ok || body.world === undefined) {
      const messages: Record<string, string> = {
        forbidden: "Your role cannot create worlds.",
        invalid_world_name: "Enter a name between 1 and 80 characters.",
        preset_release_not_ready: "This preset has no ready release yet.",
        release_not_available: "The selected release is no longer available. Refresh and try again.",
        invalid_world_connectivity: "This network is not available for the current host mode. Refresh and choose another connection.",
      };
      throw new Error(messages[body.error ?? ""] ?? "The world could not be created.");
    }
    return body.world;
  },

  async requestUpdateWorldSettings(gameId: string, worldId: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external") {
    const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/settings`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ placement, connectivity, ...(auth ? { auth } : {}) }),
    });
    if (response.ok) return;
    const body = await response.json().catch(() => ({})) as { error?: string };
    const messages: Record<string, string> = {
      forbidden: "Your role cannot change world settings.",
      world_session_active: "Stop the world and wait for the current operation to finish before changing its host or network.",
      world_settings_conflict: "The world changed while you were editing. Refresh and try again.",
      invalid_world_connectivity: "This host and network combination is not available in this deployment.",
      unknown_world: "This world no longer exists.",
    };
    throw new Error(messages[body.error ?? ""] ?? "World settings could not be saved.");
  },

  async requestPackDownload(gameId: string, worldId: string) {
    const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/pack`);
    const body = await response.json() as { error?: string; release?: string; url?: string };
    if (!response.ok || body.url === undefined || body.release === undefined) {
      const messages: Record<string, string> = {
        forbidden: "Your role cannot read this world's connection details.",
        no_release_pointer: "This world has no release yet, so there is no pack to install.",
        no_release_selected: "This world's release pointer names no release yet.",
        no_pack_published: "This release was published before packs existed. Ask the owner to publish one.",
      };
      throw new Error(messages[body.error ?? ""] ?? "The pack link could not be created.");
    }
    return { release: body.release, url: body.url };
  },

  async updateGameSettings(gameId: string, worldId: string, values: Readonly<Record<string, SettingValue>>): Promise<WorldGameSettings> {
    const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/game-settings`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ values }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string; setting?: string } & Partial<WorldGameSettings>;
    if (response.ok && body.values !== undefined) return { values: body.values, updatedAt: body.updatedAt ?? null };
    const messages: Record<string, string> = {
      forbidden: "Your role cannot change this world's game settings.",
      world_settings_conflict: "The world changed while you were editing. Refresh and try again.",
      world_archived: "This world is archived. Restore a backup before changing its settings.",
      unknown_world: "This world has no record to keep settings in.",
      invalid_game_setting: `${body.setting ?? "A setting"} has a value the game does not accept.`,
      unknown_game_setting: `${body.setting ?? "A setting"} is not one this game offers. Refresh and try again.`,
    };
    throw new Error(messages[body.error ?? ""] ?? "Game settings could not be saved.");
  },

  async loadReleaseMods(gameId: string, presetId: string, release: string): Promise<ReleaseMods> {
    const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/presets/${encodeURIComponent(presetId)}/releases/${encodeURIComponent(release)}`);
    const body = await response.json().catch(() => ({})) as { error?: string; release?: string; mods?: ReleaseMod[] };
    if (!response.ok || body.mods === undefined) {
      throw await apiFailure(response, body.error === "forbidden" ? "Your role cannot read releases." : body.error === "unknown_release" ? `Release ${release} is not in the store.` : "The release's mods could not be read.", body);
    }
    return { release: body.release ?? release, mods: body.mods };
  },

  async requestModDownload(gameId: string, presetId: string, release: string, sha256: string): Promise<FileLink> {
    const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/presets/${encodeURIComponent(presetId)}/releases/${encodeURIComponent(release)}/mods/${encodeURIComponent(sha256)}`);
    const body = await response.json().catch(() => ({})) as { error?: string; url?: string; expiresIn?: number };
    if (!response.ok || body.url === undefined) {
      throw new Error(body.error === "forbidden" ? "Your role cannot read releases." : body.error === "unknown_mod" ? "This release no longer lists that mod." : "The download link could not be created.");
    }
    return { url: body.url, expiresIn: body.expiresIn ?? 0 };
  },

} satisfies Partial<SpawnpointApi>;
