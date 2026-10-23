import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DescribeExecutionCommand, ListExecutionsCommand, SFNClient, StartExecutionCommand, type DescribeExecutionCommandOutput } from "@aws-sdk/client-sfn";
import { randomUUID } from "node:crypto";
import { parsePresetCatalog, type PresetObservation } from "./preset-catalog.ts";
import { observeBuild, requestReleaseBuild, type BuildRequest, type BuildSource, type ReleaseBuildPorts } from "./release-builds.ts";

const s3 = new S3Client({});
const sfn = new SFNClient({});
const missing = (error: unknown) => error instanceof Error && ["NoSuchKey", "NotFound", "ExecutionDoesNotExist"].includes(error.name);
const conflict = (error: unknown) => error instanceof Error && ["PreconditionFailed", "ConditionalRequestConflict"].includes(error.name);
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Legacy GitHub builds predate the panel's durable attempt record. Discover
// those candidates read-only; POST adopts one with the same conditional claim
// as a new request. The view cache never authorizes a write.
let historyCache: { until: number; promise: Promise<readonly DescribeExecutionCommandOutput[]> } | null = null;
async function buildHistory(fresh: boolean): Promise<readonly DescribeExecutionCommandOutput[]> {
  if (!fresh && historyCache && historyCache.until > Date.now()) return historyCache.promise;
  const read = async () => {
    const stateMachineArn = process.env.BUILD_RELEASE_STATE_MACHINE_ARN;
    if (!stateMachineArn) return [];
    const results: DescribeExecutionCommandOutput[] = [];
    let nextToken: string | undefined;
    do {
      const page = await sfn.send(new ListExecutionsCommand({ stateMachineArn, maxResults: 100, ...(nextToken ? { nextToken } : {}) }));
      results.push(...await Promise.all((page.executions ?? []).map((entry) => sfn.send(new DescribeExecutionCommand({ executionArn: entry.executionArn! })))));
      nextToken = page.nextToken;
    } while (nextToken);
    return results;
  };
  const promise = read();
  if (!fresh) historyCache = { until: Date.now() + 30_000, promise };
  return promise;
}

async function legacyCandidate(preset: PresetObservation, catalog: unknown, fresh: boolean): Promise<BuildRequest | null> {
  return legacyBuildCandidate(preset, catalog, await buildHistory(fresh));
}

export function legacyBuildCandidate(preset: PresetObservation, catalog: unknown, history: readonly DescribeExecutionCommandOutput[]): BuildRequest | null {
  const current = catalogBuildSource(catalog, preset.gameId);
  if (!current) return null;
  const candidates = history.flatMap((entry) => {
    let value: Record<string, unknown>;
    try { value = JSON.parse(entry.input ?? "null") as typeof value; } catch { return []; }
    if (!value || value.profileId !== preset.id || typeof value.release !== "string" || !/^[0-9]+\.[0-9]+$/.test(value.release) ||
      !entry.name || !entry.startDate) return [];
    const source = catalogBuildSource({ schema_version: 2, game: preset.gameId, presets: [], source: {
      repository: value.configRepositoryUrl, commit: value.configCommit,
      snapshot: { key: value.configSourceKey, sha256: value.configSourceSha256 },
    } }, preset.gameId);
    if (!source || source.configRepositoryUrl.replace(/\.git$/, "") !== preset.repository.replace(/\.git$/, "") ||
      (source.configCommit !== current.configCommit && source.configCommit !== preset.commit)) return [];
    return [{ entry, source, release: value.release }];
  }).sort((a, b) => b.entry.startDate!.getTime() - a.entry.startDate!.getTime());
  const latest = candidates[0];
  if (!latest) return null;
  return {
    gameId: preset.gameId, profileId: preset.id, profileDigest: preset.profileDigest,
    release: latest.release, attempt: candidates.filter((item) => item.release === latest.release).length,
    name: latest.entry.name!, requestedBy: "github-actions", requestedAt: latest.entry.startDate!.toISOString(), source: latest.source,
  };
}

type RunningBuild = Readonly<{ profileId: string; repository: string; name: string }>;
export async function runningReleaseBuilds(): Promise<readonly RunningBuild[]> {
  const stateMachineArn = process.env.BUILD_RELEASE_STATE_MACHINE_ARN;
  if (!stateMachineArn) return [];
  const builds: RunningBuild[] = [];
  let nextToken: string | undefined;
  do {
    const page = await sfn.send(new ListExecutionsCommand({ stateMachineArn, statusFilter: "RUNNING", maxResults: 100, ...(nextToken ? { nextToken } : {}) }));
    const descriptions = await Promise.all((page.executions ?? []).map((entry) => sfn.send(new DescribeExecutionCommand({ executionArn: entry.executionArn! }))));
    for (const entry of descriptions) {
      const input: unknown = JSON.parse(entry.input ?? "{}");
      if (!input || typeof input !== "object" || !("profileId" in input) || !("configRepositoryUrl" in input) ||
        typeof input.profileId !== "string" || typeof input.configRepositoryUrl !== "string" || !entry.name) throw new Error("build_status_unavailable");
      builds.push({ profileId: input.profileId, repository: input.configRepositoryUrl.replace(/\.git$/, ""), name: entry.name });
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return builds;
}

export function catalogBuildSource(value: unknown, gameId: string): BuildSource | null {
  if (parsePresetCatalog(value, gameId) === null) return null;
  const source = (value as { source: { repository: string; commit: string; snapshot?: { key?: unknown; sha256?: unknown } } }).source;
  const repository = `DrArzter/my-docker-${gameId === "minecraft" ? "minecraft" : gameId === "factorio" ? "factorio" : gameId === "zomboid" ? "zomboid" : "invalid"}-server-config`;
  if (source.repository.replace(/\.git$/, "") !== `https://github.com/${repository}`) return null;
  const snapshot = source.snapshot;
  if (!snapshot || snapshot.key !== `config-sources/${repository}/${source.commit}.tar.gz` || typeof snapshot.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(snapshot.sha256)) return null;
  return { configCommit: source.commit, configRepositoryUrl: source.repository, configSourceKey: snapshot.key as string, configSourceSha256: snapshot.sha256 };
}

function ports(gameId: string, profileId: string): ReleaseBuildPorts {
  const Bucket = process.env.RELEASE_BUCKET;
  const machine = process.env.BUILD_RELEASE_STATE_MACHINE_ARN;
  if (!Bucket || !machine) throw new Error("build_not_available");
  const Key = `preset-builds/${gameId}/${profileId}.json`;
  const executionArn = (name: string) => `${machine.replace(":stateMachine:", ":execution:")}:${name}`;
  return {
    async read() {
      try {
        const result = await s3.send(new GetObjectCommand({ Bucket, Key }));
        const request = JSON.parse(await result.Body!.transformToString()) as BuildRequest;
        const source = catalogBuildSource({ schema_version: 2, game: gameId, presets: [], source: {
          repository: request.source?.configRepositoryUrl, commit: request.source?.configCommit,
          snapshot: { key: request.source?.configSourceKey, sha256: request.source?.configSourceSha256 },
        } }, gameId);
        // Private build records are written only by this adapter. Fail closed
        // on a wrong key or shape instead of dispatching arbitrary SFN input.
        if (request.gameId !== gameId || request.profileId !== profileId || !/^[0-9a-f]{64}$/.test(request.profileDigest) ||
          !/^[0-9]+\.[0-9]+$/.test(request.release) || !/^[A-Za-z0-9_-]{1,80}$/.test(request.name) ||
          !Number.isSafeInteger(request.attempt) || request.attempt < 1 || !result.ETag ||
          typeof request.requestedBy !== "string" || request.requestedBy.length === 0 || source === null ||
          Number.isNaN(Date.parse(request.requestedAt))) throw new Error("invalid_build_record");
        return { request, etag: result.ETag };
      } catch (error) { if (missing(error)) return null; throw error; }
    },
    async claim(request, etag) {
      try {
        await s3.send(new PutObjectCommand({ Bucket, Key, Body: JSON.stringify(request), ContentType: "application/json", ServerSideEncryption: "AES256", ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }) }));
        return true;
      } catch (error) { if (conflict(error)) return false; throw error; }
    },
    async execution(name) {
      try {
        const result = await sfn.send(new DescribeExecutionCommand({ executionArn: executionArn(name) }));
        if (!result.status || result.status === "PENDING_REDRIVE") throw new Error("build_status_unavailable");
        return result.status;
      } catch (error) { if (missing(error)) return null; throw error; }
    },
    async published(request) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket, Key: `releases/${gameId}/${profileId}/${request.release}/manifest.json` }));
        return true;
      } catch (error) { if (missing(error)) return false; throw error; }
    },
    async start(request) {
      const { profileId: profile, release, source } = request;
      // The immutable source and version are persisted before dispatch. All
      // retries of StartExecution use byte-identical input for AWS idempotency.
      await sfn.send(new StartExecutionCommand({ stateMachineArn: machine, name: request.name, input: JSON.stringify({ profileId: profile, release, ...source, requestedBy: request.requestedBy }) }));
    },
  };
}

export async function presetBuildView(preset: PresetObservation, catalog: unknown, running: readonly RunningBuild[]): Promise<PresetObservation> {
  if (!process.env.BUILD_RELEASE_STATE_MACHINE_ARN) return preset;
  const source = catalogBuildSource(catalog, preset.gameId);
  const adapter = ports(preset.gameId, preset.id);
  const saved = await adapter.read();
  const request = saved?.request ?? await legacyCandidate(preset, catalog, false);
  const stored = request ? { request } : null;
  if (running.some((build) => build.repository === preset.repository.replace(/\.git$/, "") && build.profileId === preset.id && build.name !== stored?.request.name)) {
    return { ...preset, buildAvailable: source !== null, buildStatus: "building" };
  }
  if (stored === null) return { ...preset, buildAvailable: source !== null };
  const build = await observeBuild(stored.request, adapter);
  if (stored.request.profileDigest !== preset.profileDigest && (build.state === "ready" || build.state === "failed")) return { ...preset, buildAvailable: source !== null };
  return {
    ...preset, buildAvailable: source !== null, build, buildStatus: build.state === "starting" ? "building" : build.state,
    ...(build.state === "ready" && !preset.releases.includes(build.release)
      ? { releases: [...preset.releases, build.release], latestRelease: build.release } : {}),
  };
}

export async function startPresetBuild(gameId: string, profileId: string, requestedBy: string, expected: Readonly<{ profileDigest: string; retryRelease?: string }>): Promise<BuildRequest> {
  if (!ID.test(gameId) || !ID.test(profileId)) throw new Error("unknown_preset");
  const result = await s3.send(new GetObjectCommand({ Bucket: process.env.RELEASE_BUCKET!, Key: `presets/${gameId}/catalog.json` }));
  const catalog: unknown = JSON.parse(await result.Body!.transformToString());
  const preset = parsePresetCatalog(catalog, gameId)?.find((item) => item.id === profileId);
  if (!preset) throw new Error("unknown_preset");
  const adapter = ports(gameId, profileId);
  if (!await adapter.read()) {
    const legacy = await legacyCandidate(preset, catalog, true);
    if (legacy && !await adapter.claim(legacy, null)) throw new Error("build_in_progress");
  }
  const prior = expected.retryRelease ? await adapter.read() : null;
  if (expected.retryRelease
    ? prior?.request.release !== expected.retryRelease || prior.request.profileDigest !== expected.profileDigest
    : preset.profileDigest !== expected.profileDigest) throw new Error("build_changed");
  const source = catalogBuildSource(catalog, gameId);
  if (!source) throw new Error("build_not_available");
  if ((await runningReleaseBuilds()).some((build) => build.repository === preset.repository.replace(/\.git$/, "") && build.profileId === profileId)) throw new Error("build_in_progress");
  return requestReleaseBuild({ gameId, profileId, profileDigest: expected.profileDigest, source, requestedBy, now: new Date(), nonce: randomUUID(), ...(expected.retryRelease ? { retryRelease: expected.retryRelease } : {}) }, adapter);
}
