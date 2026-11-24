import { createHash } from "node:crypto";

import type { ConfigFile, ConfigFileContent, ConfigFileList, ConfigFileSource, SavedConfigFile } from "../../../../contract/config-files.ts";
import { byCodeUnit } from "../../control-plane/backups.ts";
import { type Identity } from "../../access/domain.ts";
import { findGameModule } from "../../control-plane/game-modules.ts";
import { type ControlPlaneSources } from "../../control-plane/read-model.ts";
import { manifestUsesObjects } from "../../control-plane/release-objects.ts";
import {
  configPathValid, configText, insideWorldData, textExtension,
  type ConfigFileRules, type ConfigFileStore, type ReleaseConfigFile, type WorldConfigFiles,
} from "../../control-plane/world-config.ts";
import { type WorldRecords } from "../../control-plane/world-records.ts";
import { type WorldRecord } from "../../control-plane/world-registry.ts";
import { type Response, response, parseJsonObject, errorResponse } from "./http.ts";

// A world's own config files (ADR-0093): what the next start writes over the
// release's files, read and changed one file at a time.

export type WorldConfigDependencies = Readonly<{
  sources: Pick<ControlPlaneSources, "readReleasePointer" | "readReleaseManifest">;
  worlds: Pick<WorldRecords, "read" | "updateConfigFiles">;
  files: ConfigFileStore;
  now: () => Date;
}>;

type Release = Readonly<{ gameId: string; presetId: string; release: string; objects: boolean }>;

type Context = Readonly<{
  rules: ConfigFileRules;
  record: WorldRecord;
  release: Release | null;
  releaseFiles: ReadonlyMap<string, ReleaseConfigFile>;
  worldData: readonly string[];
}>;

const SHA256 = /^[0-9a-f]{64}$/;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function releaseFilesOf(manifest: unknown, rules: ConfigFileRules): Readonly<{ files: ReadonlyMap<string, ReleaseConfigFile>; worldData: readonly string[] }> {
  const server = (manifest as { server?: { overrides?: unknown; world_data?: unknown } } | null)?.server;
  const overrides = Array.isArray(server?.overrides) ? server.overrides : [];
  const files = new Map<string, ReleaseConfigFile>();
  for (const entry of overrides as readonly Record<string, unknown>[]) {
    const { path, sha256: digest, bytes } = entry;
    if (configPathValid(path, rules) && typeof digest === "string" && SHA256.test(digest) && typeof bytes === "number") {
      files.set(path, { path, sha256: digest, bytes });
    }
  }
  const worldData = Array.isArray(server?.world_data) ? (server.world_data as unknown[]).filter((path): path is string => typeof path === "string") : [];
  return { files, worldData };
}

function editable(path: string, bytes: number, found: Context): boolean {
  return textExtension(path, found.rules) && bytes <= found.rules.maxBytes && !insideWorldData(path, found.worldData);
}

function effectiveSha(path: string, found: Context, current: WorldConfigFiles): string | null {
  return current[path]?.sha256 ?? found.releaseFiles.get(path)?.sha256 ?? null;
}

/** Where the next start takes a file from. */
function sourceOf(hasEdit: boolean, inRelease: boolean): ConfigFileSource {
  if (!hasEdit) return "release";
  return inRelease ? "world" : "world_only";
}

export function worldConfigFeature({ sources, worlds, files, now }: WorldConfigDependencies) {
  async function context(gameId: string, worldId: string): Promise<Context | Response> {
    const rules = findGameModule(gameId)?.configFileRules ?? null;
    if (rules === null) return errorResponse(409, "game_has_no_config_files");
    const record = await worlds.read(worldId);
    if (record?.gameId !== gameId) return errorResponse(404, "unknown_world");
    const pointer = await sources.readReleasePointer(worldId, record.currentGeneration.id);
    const version = pointer.state === "available" ? pointer.desiredRelease ?? pointer.activeRelease : null;
    if (version === null) return { rules, record, release: null, releaseFiles: new Map(), worldData: [] };
    const manifest = await sources.readReleaseManifest?.(gameId, record.preset.id, version) ?? null;
    const { files: releaseFiles, worldData } = releaseFilesOf(manifest, rules);
    return { rules, record, release: { gameId, presetId: record.preset.id, release: version, objects: manifestUsesObjects(manifest) }, releaseFiles, worldData };
  }

  // The bytes the next start writes: the world's version, else the release's.
  async function stored(worldId: string, worldSha: string | null, released: ReleaseConfigFile | null, release: Release | null): Promise<Uint8Array | null> {
    if (worldSha !== null) return files.readWorldFile(worldId, worldSha);
    if (release === null || released === null) return null;
    return files.readReleaseFile(release, released);
  }

  return {
    async listConfigFiles(gameId: string, worldId: string): Promise<Response> {
      const found = await context(gameId, worldId);
      if ("statusCode" in found) return found;
      const own = found.record.configFiles ?? {};
      const paths = [...new Set([...found.releaseFiles.keys(), ...Object.keys(own)])].sort(byCodeUnit);
      const list: ConfigFile[] = paths.map((path) => {
        const released = found.releaseFiles.get(path) ?? null;
        const edit = own[path] ?? null;
        const bytes = edit?.bytes ?? released?.bytes ?? 0;
        return {
          path,
          source: sourceOf(edit !== null, released !== null),
          bytes,
          editable: editable(path, bytes, found),
          releaseSha256: released?.sha256 ?? null,
          worldSha256: edit?.sha256 ?? null,
          updatedAt: edit?.updatedAt ?? null,
          updatedBy: edit?.updatedBy.displayName ?? null,
          releaseChanged: edit !== null && released !== null && edit.baseSha256 !== released.sha256,
        };
      });
      const body: ConfigFileList = { release: found.release?.release ?? null, roots: found.rules.roots, maxBytes: found.rules.maxBytes, files: list };
      return response(200, body);
    },

    async readConfigFile(gameId: string, worldId: string, path: string | undefined): Promise<Response> {
      const found = await context(gameId, worldId);
      if ("statusCode" in found) return found;
      if (!configPathValid(path, found.rules)) return errorResponse(400, "invalid_config_path");
      const edit = found.record.configFiles?.[path] ?? null;
      const released = found.releaseFiles.get(path) ?? null;
      if (edit === null && released === null) return errorResponse(404, "unknown_config_file");
      if (!editable(path, edit?.bytes ?? released!.bytes, found)) return errorResponse(409, "config_file_not_editable");
      const bytes = await stored(worldId, edit?.sha256 ?? null, released, found.release);
      if (bytes === null) return errorResponse(404, "unknown_config_file");
      const text = configText(bytes, found.rules);
      if (!text.ok) return errorResponse(409, "config_file_not_editable");
      const body: ConfigFileContent = {
        path, source: sourceOf(edit !== null, released !== null), text: text.text,
        sha256: edit?.sha256 ?? released!.sha256, releaseSha256: released?.sha256 ?? null,
      };
      return response(200, body);
    },

    async saveConfigFile(identity: Identity, gameId: string, worldId: string, body: string | undefined): Promise<Response> {
      const parsed = parseJsonObject({ body });
      const found = await context(gameId, worldId);
      if ("statusCode" in found) return found;
      const { path, text, expectedSha256 } = parsed;
      if (!configPathValid(path, found.rules)) return errorResponse(400, "invalid_config_path");
      if (typeof text !== "string" || (expectedSha256 !== null && (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)))) {
        return errorResponse(400, "invalid_json");
      }
      if (!textExtension(path, found.rules) || insideWorldData(path, found.worldData)) return errorResponse(409, "config_file_not_editable");
      const bytes = new TextEncoder().encode(text);
      const checked = configText(bytes, found.rules);
      if (!checked.ok) return errorResponse(checked.error === "config_file_too_large" ? 413 : 400, checked.error);
      const digest = sha256(bytes);
      const released = found.releaseFiles.get(path) ?? null;
      // The release's own bytes are no edit: saving them takes the world's version away.
      const sameAsRelease = released?.sha256 === digest;
      if (!sameAsRelease) await files.putWorldFile(worldId, digest, bytes);
      const updatedAt = now().toISOString();
      const result = await worlds.updateConfigFiles(gameId, worldId, (current) => {
        if (effectiveSha(path, found, current) !== expectedSha256) return { refused: "config_file_changed" };
        const { [path]: _previous, ...rest } = current;
        return sameAsRelease ? { files: rest } : { files: { ...rest, [path]: {
          sha256: digest, bytes: bytes.byteLength, baseSha256: released?.sha256 ?? null, updatedAt,
          updatedBy: { identityId: identity.id, displayName: identity.displayName },
        } } };
      });
      const refusal = refused(result);
      if (refusal !== null) return refusal;
      console.info(JSON.stringify({ event: "world_config_saved", worldId, path, sha256: digest, identityId: identity.id }));
      const saved: SavedConfigFile = { path, sha256: digest, updatedAt };
      return response(200, saved);
    },

    async resetConfigFile(identity: Identity, gameId: string, worldId: string, path: string | undefined, expectedSha256: string | undefined): Promise<Response> {
      const found = await context(gameId, worldId);
      if ("statusCode" in found) return found;
      if (!configPathValid(path, found.rules)) return errorResponse(400, "invalid_config_path");
      const result = await worlds.updateConfigFiles(gameId, worldId, (current) => {
        const edit = current[path];
        if (edit === undefined) return { refused: "unknown_config_file" };
        if (edit.sha256 !== expectedSha256) return { refused: "config_file_changed" };
        const { [path]: _removed, ...rest } = current;
        return { files: rest };
      });
      const refusal = refused(result);
      if (refusal !== null) return refusal;
      console.info(JSON.stringify({ event: "world_config_reset", worldId, path, identityId: identity.id }));
      return response(200, { path, source: found.releaseFiles.has(path) ? "release" : null });
    },
  };
}

function refused(result: Awaited<ReturnType<WorldRecords["updateConfigFiles"]>>): Response | null {
  switch (result) {
    case "updated": return null;
    case "missing": return errorResponse(404, "unknown_world");
    case "archived": return errorResponse(409, "world_archived");
    case "unknown_config_file": return errorResponse(404, "unknown_config_file");
    case "conflict":
    case "config_file_changed": return errorResponse(409, "config_file_changed");
  }
}

export type WorldConfigFeature = ReturnType<typeof worldConfigFeature>;
