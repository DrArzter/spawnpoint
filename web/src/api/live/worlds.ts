import type { ControlPlaneSnapshot, SettingValue, WorldGameSettings } from "../../model";
import type { ApiErrorBody, FileLink, ReleaseDiff, ReleaseModPage, ReleaseModQuery, ReleasePackName, SavedWhitelist, SessionOperation, SpawnpointApi, StopPlayersPolicy, WorldLifecycleAction, WorldWhitelist } from "../contract";
import { API_ERROR_TEXT } from "../error-text";
import { request, requestOrNull } from "./request";

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
      const body = await request<{ url?: string; ticket?: string }>("/control-plane/subscriptions", {
        method: "POST", failure: "Control-plane subscription was rejected.",
        valid: (answer) => typeof answer.url === "string" && answer.url.startsWith("wss://") && typeof answer.ticket === "string",
      });
      if (body.url === undefined || body.ticket === undefined) return;
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

const worldPath = (gameId: string, worldId: string) => `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}`;
const releasePath = (gameId: string, presetId: string, release: string) => `/games/${encodeURIComponent(gameId)}/presets/${encodeURIComponent(presetId)}/releases/${encodeURIComponent(release)}`;
const READ_RELEASES = { forbidden: "Your role cannot read releases." };

// Words that name the setting or the player come from the body's detail.
function named(template: (value: string) => string, fallback: string, key: "name" | "setting") {
  return (detail: ApiErrorBody) => {
    const value = detail[key];
    return typeof value === "string" ? template(value) : fallback;
  };
}

export const worldsApi = {
  async requestReleaseBuild(gameId: string, presetId: string, profileDigest: string, retryRelease?: string): Promise<{ release: string; attempt: number }> {
    const result = await request<{ release?: unknown; attempt?: unknown }>(`/games/${encodeURIComponent(gameId)}/presets/${encodeURIComponent(presetId)}/builds`, {
      method: "POST", body: { profileDigest, retryRelease },
      failure: "The build could not be requested. Refresh to check whether it was accepted before retrying.",
      refusals: { build_changed: "The build or its source changed, or is unavailable. Refresh before trying again." },
      valid: (built) => typeof built.release === "string" && /^\d+\.\d+$/.test(built.release) && typeof built.attempt === "number" && Number.isSafeInteger(built.attempt) && built.attempt >= 1,
    });
    return { release: result.release as string, attempt: result.attempt as number };
  },

  loadControlPlane(): Promise<ControlPlaneSnapshot> {
    return request<ControlPlaneSnapshot>("/control-plane", { failure: "The control-plane state could not be loaded.", refusals: { forbidden: "Your role cannot view server status." } });
  },

  subscribeControlPlane(onInvalidated: () => void): () => void {
    return controlPlaneSubscription(onInvalidated);
  },

  async requestSessionOperation(gameId: string, worldId: string, action: SessionOperation, players?: StopPlayersPolicy) {
    const body = await request<{ result?: "requested" | "already_stopped"; operationId?: string }>(`${worldPath(gameId, worldId)}/${action}`, {
      method: "POST", ...(players === "disconnect" ? { body: { players } } : {}),
      failure: `The ${action} request could not be accepted.`,
      refusals: { forbidden: players === "disconnect" ? "Your role cannot disconnect players." : `Your role cannot ${action} sessions.` },
      valid: (answer) => answer.result !== undefined,
    });
    return { result: body.result as "requested" | "already_stopped", ...(body.operationId ? { operationId: body.operationId } : {}) };
  },

  async requestPromotion(gameId: string, worldId: string, release: string) {
    const body = await request<{ result?: "requested" | "switched"; operationId?: string }>(`${worldPath(gameId, worldId)}/promote`, {
      method: "POST", body: { release },
      failure: "The release update could not be accepted.",
      refusals: { forbidden: "Only the Owner can update a world's release." },
      valid: (answer) => answer.result === "switched" || (answer.result === "requested" && answer.operationId !== undefined),
    });
    if (body.result === "switched") return { result: "switched" as const };
    return { result: "requested" as const, operationId: body.operationId as string };
  },

  async requestWorldLifecycle(gameId: string, worldId: string, action: WorldLifecycleAction, backupKey?: string, release?: string) {
    const body = await request<{ result?: "requested"; operationId?: string }>(`${worldPath(gameId, worldId)}/${action === "regenerate" ? "wipe" : action}`, {
      method: "POST", body: worldLifecyclePayload(action, worldId, backupKey, release),
      failure: `The ${action} request could not be accepted.`,
      refusals: { forbidden: "Your role cannot manage this world." },
      valid: (answer) => answer.result === "requested" && answer.operationId !== undefined,
    });
    return { result: body.result as "requested", operationId: body.operationId as string };
  },

  async requestCreateWorld(gameId: string, presetId: string, displayName: string, release: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external") {
    const body = await request<{ world?: { id: string; displayName: string } }>(`/games/${encodeURIComponent(gameId)}/presets/${encodeURIComponent(presetId)}/worlds`, {
      method: "POST", body: { displayName, release, placement, connectivity, ...(auth ? { auth } : {}) },
      failure: "The world could not be created.",
      refusals: { forbidden: "Your role cannot create worlds." },
      valid: (answer) => answer.world !== undefined,
    });
    return body.world as { id: string; displayName: string };
  },

  async requestUpdateWorldSettings(gameId: string, worldId: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external") {
    await request<unknown>(`${worldPath(gameId, worldId)}/settings`, {
      method: "PUT", body: { placement, connectivity, ...(auth ? { auth } : {}) },
      failure: "World settings could not be saved.",
      refusals: { forbidden: "Your role cannot change world settings.", invalid_world_connectivity: "This host and network combination is not available in this deployment." },
    });
  },

  async requestPackDownload(gameId: string, worldId: string) {
    const body = await request<{ release?: string; url?: string }>(`${worldPath(gameId, worldId)}/pack`, {
      failure: "The pack link could not be created.",
      refusals: { forbidden: "Your role cannot read this world's connection details.", no_pack_published: "This release was published before packs existed. Ask the owner to publish one." },
      valid: (answer) => answer.url !== undefined && answer.release !== undefined,
    });
    return { release: body.release as string, url: body.url as string };
  },

  async updateGameSettings(gameId: string, worldId: string, values: Readonly<Record<string, SettingValue>>): Promise<WorldGameSettings> {
    const body = await request<Partial<WorldGameSettings>>(`${worldPath(gameId, worldId)}/game-settings`, {
      method: "PUT", body: { values },
      failure: "Game settings could not be saved.",
      refusals: {
        forbidden: "Your role cannot change this world's game settings.",
        unknown_world: "This world has no record to keep settings in.",
        invalid_game_setting: named((setting) => `${setting} has a value the game does not accept.`, API_ERROR_TEXT.invalid_game_setting, "setting"),
        unknown_game_setting: named((setting) => `${setting} is not one this game offers. Refresh and try again.`, API_ERROR_TEXT.unknown_game_setting, "setting"),
      },
      valid: (answer) => answer.values !== undefined,
    });
    return { values: body.values ?? {}, updatedAt: body.updatedAt ?? null };
  },

  async loadWhitelist(gameId: string, worldId: string): Promise<WorldWhitelist> {
    const body = await request<Partial<WorldWhitelist>>(`${worldPath(gameId, worldId)}/whitelist`, {
      failure: "The whitelist could not be read.",
      refusals: { forbidden: "Your role cannot manage whitelists." },
      valid: (answer) => answer.names !== undefined,
    });
    return { managed: body.managed === true, names: body.names ?? [], updatedAt: body.updatedAt ?? null, updatedBy: body.updatedBy ?? null };
  },

  async updateWhitelist(gameId: string, worldId: string, names: readonly string[]): Promise<SavedWhitelist> {
    const body = await request<Partial<SavedWhitelist>>(`${worldPath(gameId, worldId)}/whitelist`, {
      method: "PUT", body: { names },
      failure: "The whitelist could not be saved.",
      refusals: {
        forbidden: "Your role cannot manage whitelists.",
        invalid_player_name: (detail) => typeof detail.name === "string"
          ? `${detail.name} is not a name this game accepts${typeof detail.hint === "string" ? `: ${detail.hint}` : ""}.`
          : API_ERROR_TEXT.invalid_player_name,
        duplicate_player_name: named((name) => `${name} is already on the list.`, API_ERROR_TEXT.duplicate_player_name, "name"),
        world_archived: "This world is archived. Restore a backup before changing its whitelist.",
      },
      valid: (answer) => answer.names !== undefined,
    });
    return { managed: true, names: body.names ?? [], updatedAt: body.updatedAt ?? null, updatedBy: body.updatedBy ?? null, applied: body.applied === "reloading" ? "reloading" : "next_start" };
  },

  async loadReleaseMods(gameId: string, presetId: string, release: string, query: ReleaseModQuery): Promise<ReleaseModPage> {
    // Page and size are always sent: any parameter asks for one page.
    const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize), sort: query.sort, order: query.order });
    if (query.search !== "") params.set("query", query.search);
    if (query.source !== null) params.set("source", query.source);
    const body = await request<Partial<ReleaseModPage>>(`${releasePath(gameId, presetId, release)}?${params}`, {
      failure: "The release's mods could not be read.",
      refusals: { ...READ_RELEASES, unknown_release: `Release ${release} is not in the store.` },
      valid: (answer) => answer.mods !== undefined,
    });
    const mods = body.mods ?? [];
    const total = body.total ?? mods.length;
    return {
      release: body.release ?? release,
      split: body.split ?? false,
      all: body.all ?? total,
      total,
      page: body.page ?? query.page,
      pages: body.pages ?? 1,
      pageSize: body.pageSize ?? query.pageSize,
      sources: body.sources ?? [],
      mods,
    };
  },

  loadReleaseDiff(gameId: string, presetId: string, release: string, from: string | null): Promise<ReleaseDiff | null> {
    const query = from === null ? "" : `?from=${encodeURIComponent(from)}`;
    return requestOrNull<ReleaseDiff>(`${releasePath(gameId, presetId, release)}/diff${query}`, {
      failure: "The release's changes could not be read.",
      refusals: { ...READ_RELEASES, unknown_release: `Release ${from ?? release} is not in the store.` },
      valid: (answer) => answer.serverMods !== undefined,
    }, (error) => error.status === 404 && error.code === "no_plan");
  },

  requestModDownload(gameId: string, presetId: string, release: string, sha256: string): Promise<FileLink> {
    return fileLink(`${releasePath(gameId, presetId, release)}/mods/${encodeURIComponent(sha256)}`, READ_RELEASES);
  },

  requestReleasePack(gameId: string, presetId: string, release: string, pack: ReleasePackName): Promise<FileLink> {
    return fileLink(`${releasePath(gameId, presetId, release)}/packs/${pack}`, { ...READ_RELEASES, no_pack_published: `Release ${release} has no ${pack} pack yet.` });
  },
} satisfies Partial<SpawnpointApi>;

async function fileLink(path: string, refusals: Readonly<Record<string, string>>): Promise<FileLink> {
  const body = await request<{ url?: string; expiresIn?: number }>(path, { failure: "The download link could not be created.", refusals, valid: (answer) => answer.url !== undefined });
  return { url: body.url as string, expiresIn: body.expiresIn ?? 0 };
}
