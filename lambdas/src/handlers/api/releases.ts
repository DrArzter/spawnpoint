import { type Identity } from "../../access/domain.ts";
import { startPresetBuild } from "../../control-plane/aws-release-builds.ts";
import { awsControlPlaneSources, releaseModUrl, releasePackUrl, packDownloadUrl } from "../../control-plane/aws.ts";
import { manifestClientAddons, manifestClientMods, manifestModSource, RELEASE_PACKS, releaseModLocation, type ReleasePack } from "../../control-plane/release-artifacts.ts";
import { manifestUsesObjects } from "../../control-plane/release-objects.ts";
import { parseModListQuery, releaseModPage } from "../../control-plane/release-mod-list.ts";
import { type PlanMod, type ReleasePlan, releasePlan, storedReleasePlan } from "../../control-plane/release-plan.ts";
import { packRelease } from "../../control-plane/session-control.ts";
import { releaseRetirement } from "../../control-plane/aws-release-retirement.ts";
import { retirementConfirmation } from "../../control-plane/release-retirement.ts";
import { parseObjectBody, type Response, response } from "./http.ts";

const RELEASE_ID = /^[a-z0-9][a-z0-9-]*$/;
const RELEASE_VERSION = /^\d+\.\d+$/;
const SHA256_DIGEST = /^[0-9a-f]{64}$/;
const MOD_LINK_SECONDS = 900;
const PACK_LINK_SECONDS = 900;

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

// Retire a release (ADR-0080). The dispatcher has checked release.retire, which
// only the Owner role holds. This answers only that the request was queued: the
// retirement Lambda checks the confirmation again, judges every live use and
// logs the outcome with the identity that asked.
export async function requestReleaseRetirement(identity: Identity, gameId: string, presetId: string, version: string, body: string | undefined): Promise<Response> {
  if (!RELEASE_ID.test(gameId) || !RELEASE_ID.test(presetId) || !RELEASE_VERSION.test(version)) {
    return response(400, { error: "invalid_release_reference" });
  }
  const parsed = parseObjectBody(body);
  if (parsed === null) return response(400, { error: "invalid_json" });
  const confirmation = { gameId, presetId, release: version };
  if (Object.keys(parsed).some((key) => key !== "confirmation") || parsed.confirmation !== retirementConfirmation(confirmation)) {
    return response(400, { error: "invalid_retire_confirmation" });
  }
  if (await awsControlPlaneSources.readReleaseManifest?.(gameId, presetId, version) === null) return response(404, { error: "unknown_release" });
  try {
    await releaseRetirement.request({ ...confirmation, confirmation: parsed.confirmation, requestedBy: `identity:${identity.id}` });
  } catch (error) {
    console.error("release_retirement_request_failed", { gameId, presetId, errorName: error instanceof Error ? error.name : "UnknownError" });
    return response(503, { error: "retirement_request_failed" });
  }
  console.info(JSON.stringify({ event: "release_retirement_requested", gameId, presetId, release: version, requestedBy: `identity:${identity.id}` }));
  return response(202, { status: "requested", release: version });
}

// Manifest text is data, not an arbitrary object's string representation.
function manifestText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// One mod of a release (ADR-0065), by the digest its manifest records: the
// digest names the file without putting a mod's name, whatever characters it
// holds, into a path. A players' own mod (ADR-0069) is as public as the client
// pack it ships in; whoever may read the release may have its files. The
// manifest still proves that this release names the digest; an objects-v1
// release then serves the object of that digest (ADR-0080).
export async function releaseModDownload(gameId: string, presetId: string, version: string, sha256: string): Promise<Response> {
  if (!RELEASE_ID.test(gameId) || !RELEASE_ID.test(presetId) || !RELEASE_VERSION.test(version) || !SHA256_DIGEST.test(sha256)) {
    return response(400, { error: "invalid_release_reference" });
  }
  const manifest = await awsControlPlaneSources.readReleaseManifest?.(gameId, presetId, version) ?? null;
  const location = releaseModLocation(manifest, sha256);
  if (location === null || !/^[^/\\]+\.(jar|zip)$/.test(location.file)) return response(404, { error: "unknown_mod" });
  const objectDigest = manifestUsesObjects(manifest) ? sha256 : undefined;
  return response(200, { file: location.file, url: await releaseModUrl(gameId, presetId, version, location, MOD_LINK_SECONDS, objectDigest), expiresIn: MOD_LINK_SECONDS });
}

// One pack of a release by name (ADR-0069): the players' set, the server's set,
// or every mod. Whoever may read the release may have its files, as with one mod.
export async function releasePackDownload(gameId: string, presetId: string, version: string, pack: string): Promise<Response> {
  if (!RELEASE_ID.test(gameId) || !RELEASE_ID.test(presetId) || !RELEASE_VERSION.test(version) || !(RELEASE_PACKS as readonly string[]).includes(pack)) {
    return response(400, { error: "invalid_release_reference" });
  }
  const url = await releasePackUrl(gameId, presetId, version, pack as ReleasePack, PACK_LINK_SECONDS);
  return url === null ? response(404, { error: "no_pack_published" }) : response(200, { pack, url, expiresIn: PACK_LINK_SECONDS });
}

// What a release contains, which until now lived only in S3 and in the mods
// directory of whichever host last installed it. Shaped rather than echoed: the
// manifest is a build artifact, and this is an API.
//
// Without query parameters this is the whole manifest, which the MCP tool
// reads. With any of them it answers one page of the mod list instead: the
// panel never holds a release's whole list.
export async function releaseManifest(gameId: string, presetId: string, version: string, query?: Readonly<Record<string, string | undefined>>): Promise<Response> {
  if (!RELEASE_ID.test(gameId) || !RELEASE_ID.test(presetId) || !RELEASE_VERSION.test(version)) {
    return response(400, { error: "invalid_release_reference" });
  }
  const list = parseModListQuery(query);
  if (list.kind === "invalid") return response(400, { error: "invalid_mod_query" });
  const manifest = await awsControlPlaneSources.readReleaseManifest?.(gameId, presetId, version) ?? null;
  if (manifest === null || typeof manifest !== "object") return response(404, { error: "unknown_release" });
  const value = manifest as Record<string, unknown>;
  if (list.kind === "query") {
    return response(200, { gameId, presetId, release: typeof value.release === "string" ? value.release : version, ...releaseModPage(manifest, list.query) });
  }
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
      const source = manifestModSource(mod.source);
      return { file: manifestText(mod.file), sha256: manifestText(mod.sha256), bytes: Number(mod.bytes ?? 0), ...(source ? { source } : {}) };
    }),
    // What players install when it is not the server's set (ADR-0069).
    clientMods: manifestClientMods(manifest),
    // Extra mods on top of a modpack, with their side (ADR-0077).
    addons: manifestClientAddons(manifest),
  });
}

function diffMod(mod: PlanMod) {
  return { file: mod.file, sha256: mod.sha256, bytes: mod.bytes, side: mod.side ?? null, modIds: mod.mod_ids ?? null };
}

function diffClasses(section: ReleasePlan["server_mods"]) {
  return {
    added: section.added.map(diffMod),
    removed: section.removed.map(diffMod),
    changed: section.changed.map((change) => ({ from: diffMod(change.from), to: diffMod(change.to) })),
    unchanged: section.unchanged,
  };
}

// What a release changes compared with another one of its preset (P3). The
// pair the build compared comes from its plan.json; any other pair, or a
// release built before plans existed, is diffed from the two manifests.
export async function releaseDiff(gameId: string, presetId: string, version: string, from: string | undefined): Promise<Response> {
  if (!RELEASE_ID.test(gameId) || !RELEASE_ID.test(presetId) || !RELEASE_VERSION.test(version) ||
    (from !== undefined && (!RELEASE_VERSION.test(from) || from === version))) {
    return response(400, { error: "invalid_release_reference" });
  }
  const sources = awsControlPlaneSources;
  const stored = storedReleasePlan(await sources.readReleasePlan?.(gameId, presetId, version) ?? null, version);
  let plan: ReleasePlan | null = stored !== null && (from === undefined || stored.previous_release === from) ? stored : null;
  const source = plan === null ? "manifests" : "plan";
  if (plan === null) {
    if (from === undefined) return response(404, { error: "no_plan" });
    const [next, previous] = await Promise.all([
      sources.readReleaseManifest?.(gameId, presetId, version) ?? null,
      sources.readReleaseManifest?.(gameId, presetId, from) ?? null,
    ]);
    if (next === null || previous === null) return response(404, { error: "unknown_release" });
    plan = releasePlan(next, previous);
    if (plan === null) return response(502, { error: "invalid_manifest" });
  }
  return response(200, {
    gameId,
    presetId,
    release: plan.release,
    from: plan.previous_release,
    source,
    matchedBy: plan.matched_by,
    gameVersion: plan.minecraft,
    loader: plan.loader,
    runtimeImage: plan.runtime,
    serverMods: diffClasses(plan.server_mods),
    overrides: plan.server_overrides.roots.map((root) => ({
      root: root.root, added: root.added, removed: root.removed, changed: root.changed, unchanged: root.unchanged,
    })),
    clientMods: diffClasses(plan.client_mods),
    clientPack: plan.client_pack,
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
