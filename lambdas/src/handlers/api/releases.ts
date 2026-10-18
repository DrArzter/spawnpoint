import { type Identity } from "../../access/domain.ts";
import { startPresetBuild } from "../../control-plane/aws-release-builds.ts";
import { awsControlPlaneSources, releaseModUrl, packDownloadUrl } from "../../control-plane/aws.ts";
import { packRelease } from "../../control-plane/session-control.ts";
import { type Response, response } from "./http.ts";

const RELEASE_ID = /^[a-z0-9][a-z0-9-]*$/;
const RELEASE_VERSION = /^\d+\.\d+$/;
const SHA256_DIGEST = /^[0-9a-f]{64}$/;
const MOD_LINK_SECONDS = 900;

type BuildRequest = Readonly<{ profileDigest: string; retryRelease?: string }>;

function buildRequest(input: unknown): BuildRequest | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Readonly<Record<string, unknown>>;
  if (typeof value.profileDigest !== "string" || !SHA256_DIGEST.test(value.profileDigest)) return null;
  if (value.retryRelease === undefined) return { profileDigest: value.profileDigest };
  if (typeof value.retryRelease !== "string" || !RELEASE_VERSION.test(value.retryRelease)) return null;
  return { profileDigest: value.profileDigest, retryRelease: value.retryRelease };
}

export async function buildRelease(identity: Identity, gameId: string, presetId: string, body: string | undefined): Promise<Response> {
  let parsed: unknown;
  try { parsed = body ? JSON.parse(body) as unknown : {}; } catch { return response(400, { error: "invalid_json" }); }
  const expected = buildRequest(parsed);
  if (expected === null) return response(400, { error: "invalid_build_request" });
  try {
    const build = await startPresetBuild(gameId, presetId, identity.id, expected);
    return response(202, { release: build.release, attempt: build.attempt });
  } catch (error) {
    const code = error instanceof Error ? error.message : "build_request_failed";
    if (code === "unknown_preset") return response(404, { error: code });
    if (["build_in_progress", "build_changed", "build_not_available"].includes(code)) return response(409, { error: code });
    console.error("release_build_request_failed", { gameId, presetId, errorName: error instanceof Error ? error.name : "UnknownError" });
    return response(503, { error: "build_request_failed" });
  }
}

// Manifest text is data, not an arbitrary object's string representation.
function manifestText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// One server mod of a release (ADR-0065), by the digest its manifest records:
// the digest names the file without putting a mod's name, whatever characters
// it holds, into a path. Mods are what the release already publishes to every
// host; whoever may read the release may have its files.
export async function releaseModDownload(gameId: string, presetId: string, version: string, sha256: string): Promise<Response> {
  if (!RELEASE_ID.test(gameId) || !RELEASE_ID.test(presetId) || !RELEASE_VERSION.test(version) || !SHA256_DIGEST.test(sha256)) {
    return response(400, { error: "invalid_release_reference" });
  }
  const manifest = await awsControlPlaneSources.readReleaseManifest?.(gameId, presetId, version) ?? null;
  const mods = (manifest as { server?: { mods?: unknown } } | null)?.server?.mods;
  const mod = Array.isArray(mods) ? (mods as { file?: unknown; sha256?: unknown }[]).find((entry) => entry.sha256 === sha256) : undefined;
  if (mod === undefined || typeof mod.file !== "string" || !/^[^/\\]+\.(jar|zip)$/.test(mod.file)) return response(404, { error: "unknown_mod" });
  return response(200, { file: mod.file, url: await releaseModUrl(gameId, presetId, version, mod.file, MOD_LINK_SECONDS), expiresIn: MOD_LINK_SECONDS });
}

// What a release contains, which until now lived only in S3 and in the mods
// directory of whichever host last installed it. Shaped rather than echoed: the
// manifest is a build artifact, and this is an API.
export async function releaseManifest(gameId: string, presetId: string, version: string): Promise<Response> {
  if (!RELEASE_ID.test(gameId) || !RELEASE_ID.test(presetId) || !RELEASE_VERSION.test(version)) {
    return response(400, { error: "invalid_release_reference" });
  }
  const manifest = await awsControlPlaneSources.readReleaseManifest?.(gameId, presetId, version) ?? null;
  if (manifest === null || typeof manifest !== "object") return response(404, { error: "unknown_release" });
  const value = manifest as Record<string, unknown>;
  const server = value.server as { mods?: unknown } | undefined;
  const loader = value.loader as { type?: unknown; version?: unknown } | undefined;
  const runtime = value.runtime as { image?: unknown } | undefined;
  const profile = value.source_profile as { id?: unknown; repository?: unknown; commit?: unknown } | undefined;
  const mods = Array.isArray(server?.mods) ? server.mods : [];
  return response(200, {
    gameId,
    presetId,
    release: typeof value.release === "string" ? value.release : version,
    gameVersion: typeof value.minecraft_version === "string" ? value.minecraft_version : null,
    loader: loader ? { type: manifestText(loader.type), version: manifestText(loader.version) } : null,
    createdAt: typeof value.created_at === "string" ? value.created_at : null,
    changelog: typeof value.changelog === "string" && value.changelog !== "" ? value.changelog : null,
    runtimeImage: typeof runtime?.image === "string" ? runtime.image : null,
    source: profile ? { presetId: manifestText(profile.id), repository: manifestText(profile.repository), commit: manifestText(profile.commit) } : null,
    mods: mods.map((entry) => {
      const mod = entry as Record<string, unknown>;
      return { file: manifestText(mod.file), sha256: manifestText(mod.sha256), bytes: Number(mod.bytes ?? 0) };
    }),
  });
}

// The files a player needs to join, for the release the world is actually
// running. Whoever may learn where to connect may have what it takes to
// connect: the same permission covers both, rather than inventing a second one
// that would always be granted together with it.
export async function packDownload(gameId: string, worldId: string): Promise<Response> {
  const worldRecord = await awsControlPlaneSources.listWorldRecords?.()
    .then((records) => records.find((record) => record.gameId === gameId && record.worldId === worldId));
  if (worldRecord === undefined) return response(404, { error: "unknown_world" });
  const choice = packRelease(await awsControlPlaneSources.readReleasePointer(
    worldId,
    worldRecord.currentGeneration.id,
  ));
  if (choice.kind === "none") return response(409, { error: choice.reason });

  const url = await packDownloadUrl(gameId, worldRecord.preset.id, choice.release);
  if (url === null) return response(409, { error: "no_pack_published", release: choice.release });
  return response(200, { release: choice.release, url, expiresIn: 3600 });
}
