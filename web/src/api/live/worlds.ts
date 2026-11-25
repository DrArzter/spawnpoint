import type { ControlPlaneSnapshot, SettingValue, WorldGameSettings } from "../../model";
import { ApiError, type ApiErrorBody, type AssistantAnswer, type AssistantModel, type WorldLogRead, type ConfigFileContent, type ConfigFileList, type SavedConfigFile, type FileLink, type ReleaseDiff, type ReleaseModPage, type ReleaseModQuery, type ReleasePackName, type SavedWhitelist, type SessionOperation, type SpawnpointApi, type StopPlayersPolicy, type WorldLifecycleAction, type WorldWhitelist } from "../contract";
import { API_ERROR_TEXT } from "../error-text";
import { request, requestOrNull } from "./request";
import { t } from "../../i18n";
import { operationNoun } from "../../lib/operation-words";

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
        method: "POST", failure: t("world.controlPlaneSubscriptionWasRejected"),
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
const READ_RELEASES = { forbidden: t("world.roleCannotReadReleases") };

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
      failure: t("world.buildCouldNotRequested"),
      refusals: { build_changed: t("world.buildSourceChangedUnavailable") },
      valid: (built) => typeof built.release === "string" && /^\d+\.\d+$/.test(built.release) && typeof built.attempt === "number" && Number.isSafeInteger(built.attempt) && built.attempt >= 1,
    });
    return { release: result.release as string, attempt: result.attempt as number };
  },

  loadControlPlane(): Promise<ControlPlaneSnapshot> {
    return request<ControlPlaneSnapshot>("/control-plane", { failure: t("common.controlPlaneStateCouldNot"), refusals: { forbidden: t("world.roleCannotViewServer") } });
  },

  subscribeControlPlane(onInvalidated: () => void): () => void {
    return controlPlaneSubscription(onInvalidated);
  },

  async requestSessionOperation(gameId: string, worldId: string, action: SessionOperation, players?: StopPlayersPolicy) {
    const refused = action === "start" ? t("world.roleCannotStartSessions") : t("world.roleCannotStopSessions");
    const body = await request<{ result?: "requested" | "already_stopped"; operationId?: string }>(`${worldPath(gameId, worldId)}/${action}`, {
      method: "POST", ...(players === "disconnect" ? { body: { players } } : {}),
      failure: t("world.actionRequestCouldNot", { action: operationNoun(action) }),
      refusals: { forbidden: players === "disconnect" ? t("world.roleCannotDisconnectPlayers") : refused },
      valid: (answer) => answer.result !== undefined,
    });
    return { result: body.result as "requested" | "already_stopped", ...(body.operationId ? { operationId: body.operationId } : {}) };
  },

  async requestPromotion(gameId: string, worldId: string, release: string) {
    const body = await request<{ result?: "requested" | "switched"; operationId?: string }>(`${worldPath(gameId, worldId)}/promote`, {
      method: "POST", body: { release },
      failure: t("world.releaseUpdateCouldNot"),
      refusals: { forbidden: t("world.onlyOwnerCanUpdate") },
      valid: (answer) => answer.result === "switched" || (answer.result === "requested" && answer.operationId !== undefined),
    });
    if (body.result === "switched") return { result: "switched" as const };
    return { result: "requested" as const, operationId: body.operationId as string };
  },

  async requestHostDeletion(instanceId: string, snapshot: boolean) {
    const body = await request<{ result?: "requested"; operationId?: string }>(`/hosts/${encodeURIComponent(instanceId)}`, {
      method: "DELETE", body: { snapshot },
      failure: t("host.couldNotDelete"),
      refusals: { forbidden: t("host.roleCannotDelete") },
      valid: (answer) => answer.result === "requested" && answer.operationId !== undefined,
    });
    return { operationId: body.operationId as string };
  },

  async requestWorldLifecycle(gameId: string, worldId: string, action: WorldLifecycleAction, backupKey?: string, release?: string) {
    const body = await request<{ result?: "requested"; operationId?: string }>(`${worldPath(gameId, worldId)}/${action === "regenerate" ? "wipe" : action}`, {
      method: "POST", body: worldLifecyclePayload(action, worldId, backupKey, release),
      failure: t("world.actionRequestCouldNot", { action: operationNoun(action) }),
      refusals: { forbidden: t("world.roleCannotManageWorld") },
      valid: (answer) => answer.result === "requested" && answer.operationId !== undefined,
    });
    return { result: body.result as "requested", operationId: body.operationId as string };
  },

  async requestCreateWorld(gameId: string, presetId: string, displayName: string, release: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external") {
    const body = await request<{ world?: { id: string; displayName: string } }>(`/games/${encodeURIComponent(gameId)}/presets/${encodeURIComponent(presetId)}/worlds`, {
      method: "POST", body: { displayName, release, placement, connectivity, ...(auth ? { auth } : {}) },
      failure: t("common.worldCouldNotCreated"),
      refusals: { forbidden: t("common.roleCannotCreateWorlds") },
      valid: (answer) => answer.world !== undefined,
    });
    return body.world as { id: string; displayName: string };
  },

  async requestUpdateWorldSettings(gameId: string, worldId: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external") {
    await request<unknown>(`${worldPath(gameId, worldId)}/settings`, {
      method: "PUT", body: { placement, connectivity, ...(auth ? { auth } : {}) },
      failure: t("common.worldSettingsCouldNot"),
      refusals: { forbidden: t("world.roleCannotChangeWorld"), invalid_world_connectivity: t("world.hostNetworkCombinationNot") },
    });
  },

  async requestPackDownload(gameId: string, worldId: string) {
    const body = await request<{ release?: string; url?: string }>(`${worldPath(gameId, worldId)}/pack`, {
      failure: t("world.packLinkCouldNot"),
      refusals: { forbidden: t("world.roleCannotReadWorlds"), no_pack_published: t("world.releaseWasPublishedBefore") },
      valid: (answer) => answer.url !== undefined && answer.release !== undefined,
    });
    return { release: body.release as string, url: body.url as string };
  },

  async updateGameSettings(gameId: string, worldId: string, values: Readonly<Record<string, SettingValue>>): Promise<WorldGameSettings> {
    const body = await request<Partial<WorldGameSettings>>(`${worldPath(gameId, worldId)}/game-settings`, {
      method: "PUT", body: { values },
      failure: t("common.gameSettingsCouldNot"),
      refusals: {
        forbidden: t("world.roleCannotChangeWorlds"),
        unknown_world: t("world.worldHasNoRecord"),
        invalid_game_setting: named((setting) => t("world.settingHasValueGame", { setting }), API_ERROR_TEXT.invalid_game_setting, "setting"),
        unknown_game_setting: named((setting) => t("world.settingNotOneGame", { setting }), API_ERROR_TEXT.unknown_game_setting, "setting"),
      },
      valid: (answer) => answer.values !== undefined,
    });
    return { values: body.values ?? {}, updatedAt: body.updatedAt ?? null };
  },

  async loadWhitelist(gameId: string, worldId: string): Promise<WorldWhitelist> {
    const body = await request<Partial<WorldWhitelist>>(`${worldPath(gameId, worldId)}/whitelist`, {
      failure: t("world.whitelistCouldNotRead"),
      refusals: { forbidden: t("world.roleCannotManageWhitelists") },
      valid: (answer) => answer.names !== undefined,
    });
    return { managed: body.managed === true, names: body.names ?? [], updatedAt: body.updatedAt ?? null, updatedBy: body.updatedBy ?? null };
  },

  async updateWhitelist(gameId: string, worldId: string, names: readonly string[]): Promise<SavedWhitelist> {
    const body = await request<Partial<SavedWhitelist>>(`${worldPath(gameId, worldId)}/whitelist`, {
      method: "PUT", body: { names },
      failure: t("common.whitelistCouldNotSaved"),
      refusals: {
        forbidden: t("world.roleCannotManageWhitelists"),
        invalid_player_name: (detail) => typeof detail.name === "string"
          ? t("world.detailNameNotNameGame", { detailName: detail.name, value: typeof detail.hint === "string" ? `: ${detail.hint}` : "" })
          : API_ERROR_TEXT.invalid_player_name,
        duplicate_player_name: named((name) => t("world.nameAlreadyList", { name }), API_ERROR_TEXT.duplicate_player_name, "name"),
        world_archived: t("world.worldArchivedRestoreBackup"),
      },
      valid: (answer) => answer.names !== undefined,
    });
    return { managed: true, names: body.names ?? [], updatedAt: body.updatedAt ?? null, updatedBy: body.updatedBy ?? null, applied: body.applied === "reloading" ? "reloading" : "next_start" };
  },

  async loadConfigFiles(gameId: string, worldId: string): Promise<ConfigFileList> {
    try {
      const body = await request<Partial<ConfigFileList>>(`${worldPath(gameId, worldId)}/config-files`, {
        failure: t("world.configFilesCouldNot"),
        refusals: { forbidden: t("world.roleCannotEditConfig") },
        valid: (answer) => Array.isArray(answer.files),
      });
      return { release: body.release ?? null, roots: body.roots ?? [], maxBytes: body.maxBytes ?? 0, files: body.files ?? [] };
    } catch (error) {
      // A game with no config rules has nothing to list, which is not a failure.
      if (error instanceof ApiError && error.code === "game_has_no_config_files") return { release: null, roots: [], maxBytes: 0, files: [] };
      throw error;
    }
  },

  async loadConfigFile(gameId: string, worldId: string, path: string): Promise<ConfigFileContent> {
    return request<ConfigFileContent>(`${worldPath(gameId, worldId)}/config-files/content?${new URLSearchParams({ path })}`, {
      failure: t("world.fileCouldNotRead"),
      refusals: { forbidden: t("world.roleCannotEditConfig") },
      valid: (answer) => typeof answer.text === "string" && typeof answer.sha256 === "string",
    });
  },

  async saveConfigFile(gameId: string, worldId: string, path: string, text: string, expectedSha256: string | null): Promise<SavedConfigFile> {
    return request<SavedConfigFile>(`${worldPath(gameId, worldId)}/config-files`, {
      method: "PUT", body: { path, text, expectedSha256 },
      failure: t("common.fileCouldNotSaved"),
      refusals: {
        forbidden: t("world.roleCannotEditConfig"),
        world_archived: t("world.worldArchivedRestoreBackupBefore"),
      },
      valid: (answer) => typeof answer.sha256 === "string",
    });
  },

  async resetConfigFile(gameId: string, worldId: string, path: string, expected: string | null): Promise<void> {
    const params = new URLSearchParams({ path });
    if (expected !== null) params.set("expected", expected);
    await request<unknown>(`${worldPath(gameId, worldId)}/config-files?${params}`, {
      method: "DELETE",
      failure: t("common.fileCouldNotReset"),
      refusals: { forbidden: t("world.roleCannotEditConfig") },
    });
  },

  async requestWorldLog(gameId: string, worldId: string): Promise<WorldLogRead> {
    const body = await request<{ read: WorldLogRead }>(`${worldPath(gameId, worldId)}/log`, {
      method: "POST", body: {},
      failure: t("world.logCouldNotRequested"),
      refusals: { forbidden: t("world.roleCannotReadLog"), session_not_ready: t("error.session_not_ready") },
      valid: (answer) => typeof answer.read?.id === "string",
    });
    return body.read;
  },

  async loadWorldLog(gameId: string, worldId: string, readId: string): Promise<WorldLogRead> {
    const body = await request<{ read: WorldLogRead }>(`${worldPath(gameId, worldId)}/log/${encodeURIComponent(readId)}`, {
      failure: t("world.logCouldNotRead"),
      refusals: { forbidden: t("world.roleCannotReadLog") },
      valid: (answer) => typeof answer.read?.status === "string",
    });
    return body.read;
  },

  async askAssistant(gameId: string, worldId: string, question: Readonly<{ logReadId: string; model: AssistantModel; question: string | null }>): Promise<AssistantAnswer> {
    const body = await request<{ answer: AssistantAnswer }>(`${worldPath(gameId, worldId)}/assistant`, {
      method: "POST", body: question,
      failure: t("common.questionCouldNotSent"),
      refusals: { forbidden: t("world.onlyOwnerCanAsk") },
      valid: (answer) => typeof answer.answer?.id === "string",
    });
    return body.answer;
  },

  async loadAssistantAnswer(gameId: string, worldId: string, answerId: string): Promise<AssistantAnswer> {
    const body = await request<{ answer: AssistantAnswer }>(`${worldPath(gameId, worldId)}/assistant/${encodeURIComponent(answerId)}`, {
      failure: t("world.answerCouldNotRead"),
      refusals: { forbidden: t("world.onlyOwnerCanAsk") },
      valid: (answer) => typeof answer.answer?.status === "string",
    });
    return body.answer;
  },

  async loadReleaseMods(gameId: string, presetId: string, release: string, query: ReleaseModQuery): Promise<ReleaseModPage> {
    // Page and size are always sent: any parameter asks for one page.
    const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize), sort: query.sort, order: query.order });
    if (query.search !== "") params.set("query", query.search);
    if (query.source !== null) params.set("source", query.source);
    const body = await request<Partial<ReleaseModPage>>(`${releasePath(gameId, presetId, release)}?${params}`, {
      failure: t("world.releasesModsCouldNot"),
      refusals: { ...READ_RELEASES, unknown_release: t("world.releaseReleaseNotStore", { release }) },
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
      failure: t("world.releasesChangesCouldNot"),
      refusals: { ...READ_RELEASES, unknown_release: t("world.releaseReleaseNotStore", { release: from ?? release }) },
      valid: (answer) => answer.serverMods !== undefined,
    }, (error) => error.status === 404 && error.code === "no_plan");
  },

  requestModDownload(gameId: string, presetId: string, release: string, sha256: string): Promise<FileLink> {
    return fileLink(`${releasePath(gameId, presetId, release)}/mods/${encodeURIComponent(sha256)}`, READ_RELEASES);
  },

  requestReleasePack(gameId: string, presetId: string, release: string, pack: ReleasePackName): Promise<FileLink> {
    return fileLink(`${releasePath(gameId, presetId, release)}/packs/${pack}`, { ...READ_RELEASES, no_pack_published: t("world.releaseReleaseHasNo", { release, pack }) });
  },
} satisfies Partial<SpawnpointApi>;

async function fileLink(path: string, refusals: Readonly<Record<string, string>>): Promise<FileLink> {
  const body = await request<{ url?: string; expiresIn?: number }>(path, { failure: t("common.downloadLinkCouldNot"), refusals, valid: (answer) => answer.url !== undefined });
  return { url: body.url as string, expiresIn: body.expiresIn ?? 0 };
}
