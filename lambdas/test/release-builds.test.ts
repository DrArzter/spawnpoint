import assert from "node:assert/strict";
import test from "node:test";
import { observeBuild, requestReleaseBuild, type BuildRequest, type ReleaseBuildPorts, type StoredBuild } from "../src/control-plane/release-builds.ts";
import { catalogBuildSource, legacyBuildCandidate } from "../src/control-plane/aws-release-builds.ts";
import type { DescribeExecutionCommandOutput } from "@aws-sdk/client-sfn";

const source = { configCommit: "a".repeat(40), configRepositoryUrl: "https://github.com/DrArzter/my-docker-minecraft-server-config", configSourceKey: `config-sources/DrArzter/my-docker-minecraft-server-config/${"a".repeat(40)}.tar.gz`, configSourceSha256: "b".repeat(64) };
const input = { gameId: "minecraft", profileId: "main", profileDigest: "c".repeat(64), source, requestedBy: "owner", now: new Date("2026-10-18T12:00:00Z"), nonce: "11111111-1111-4111-8111-111111111111" };

function fixture() {
  let stored: StoredBuild | null = null;
  let generation = 0;
  let status: Awaited<ReturnType<ReleaseBuildPorts["execution"]>> = null;
  let published = false;
  let failStart = false;
  const started: BuildRequest[] = [];
  const ports: ReleaseBuildPorts = {
    async read() { return stored; },
    async claim(request, etag) {
      if ((stored?.etag ?? null) !== etag) return false;
      stored = { request, etag: String(++generation) };
      return true;
    },
    async execution() { return status; },
    async published() { return published; },
    async start(request) { if (failStart) throw new Error("network"); started.push(request); },
  };
  return { ports, started, get request() { return stored!.request; }, set status(value: typeof status) { status = value; }, set published(value: boolean) { published = value; }, set failStart(value: boolean) { failStart = value; } };
}

test("claim precedes dispatch; retries keep the release and exact original snapshot", async () => {
  const f = fixture();
  const first = await requestReleaseBuild(input, f.ports);
  assert.match(first.release, /^[0-9]+\.[0-9]+$/);
  assert.equal(f.request, first);
  assert.equal(first.attempt, 1);
  for (const status of ["FAILED", "TIMED_OUT", "ABORTED", "SUCCEEDED"] as const) {
    f.status = status;
    const previous = f.request;
    const retry = await requestReleaseBuild({ ...input, source: { ...source, configCommit: "d".repeat(40) }, nonce: `${status.length}1111111-1111-4111-8111-111111111111` }, f.ports);
    assert.equal(retry.release, first.release);
    assert.deepEqual(retry.source, first.source);
    assert.equal(retry.attempt, previous.attempt + 1);
    assert.notEqual(retry.name, previous.name);
  }
});

test("double clicks and concurrent callers cannot dispatch two attempts", async () => {
  const f = fixture();
  const results = await Promise.allSettled([requestReleaseBuild(input, f.ports), requestReleaseBuild({ ...input, nonce: "22222222-2222-4222-8222-222222222222" }, f.ports)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(f.started.length, 1);
  f.status = "RUNNING";
  const existing = await requestReleaseBuild(input, f.ports);
  assert.equal(existing.name, f.request.name);
  assert.equal(f.started.length, 1);
  await assert.rejects(requestReleaseBuild({ ...input, profileDigest: "d".repeat(64) }, f.ports), /build_in_progress/);
});

test("a lost dispatch is recovered using the persisted AWS idempotency key and input", async () => {
  const f = fixture();
  f.failStart = true;
  await assert.rejects(requestReleaseBuild(input, f.ports), /network/);
  const claimed = f.request;
  f.failStart = false;
  const recovered = await requestReleaseBuild({ ...input, source: { ...source, configCommit: "d".repeat(40) } }, f.ports);
  assert.deepEqual(recovered, claimed);
  assert.deepEqual(f.started, [claimed]);
});

test("a committed manifest cannot be retried even when the workflow failed afterward", async () => {
  const f = fixture();
  const first = await requestReleaseBuild(input, f.ports);
  f.published = true;
  f.status = "FAILED";
  assert.equal((await observeBuild(first, f.ports)).state, "ready");
  const next = await requestReleaseBuild({ ...input, now: new Date(input.now.getTime() + 1), nonce: "22222222-2222-4222-8222-222222222222" }, f.ports);
  assert.notEqual(next.release, first.release);
  assert.equal(next.attempt, 1);
});

test("a changed preset starts a separate release, never retries old inputs", async () => {
  const f = fixture();
  const first = await requestReleaseBuild(input, f.ports);
  f.status = "FAILED";
  const changed = { ...input, profileDigest: "d".repeat(64), source: { ...source, configCommit: "e".repeat(40) }, nonce: "22222222-2222-4222-8222-222222222222" };
  const next = await requestReleaseBuild(changed, f.ports);
  assert.notEqual(next.release, first.release);
  assert.deepEqual(next.source, changed.source);
});

test("a stale retry confirmation never silently allocates a new release", async () => {
  const f = fixture();
  await assert.rejects(requestReleaseBuild({ ...input, retryRelease: "1.0" }, f.ports), /build_changed/);
  const first = await requestReleaseBuild(input, f.ports);
  f.status = "FAILED";
  await assert.rejects(requestReleaseBuild({ ...input, retryRelease: first.release, profileDigest: "d".repeat(64) }, f.ports), /build_changed/);
  f.published = true;
  await assert.rejects(requestReleaseBuild({ ...input, retryRelease: first.release }, f.ports), /build_changed/);
  assert.equal(f.started.length, 1);
});

test("only a validated, repository-bound catalog snapshot can be built", () => {
  const catalog = { schema_version: 2, game: "minecraft", source: { repository: source.configRepositoryUrl, commit: source.configCommit, snapshot: { key: source.configSourceKey, sha256: source.configSourceSha256 } }, presets: [] };
  assert.deepEqual(catalogBuildSource(catalog, "minecraft"), source);
  for (const snapshot of [null, {}, { key: "arbitrary/key", sha256: "b".repeat(64) }, { key: source.configSourceKey, sha256: "bad" }]) {
    assert.equal(catalogBuildSource({ ...catalog, source: { ...catalog.source, snapshot } }, "minecraft"), null);
  }
  assert.equal(catalogBuildSource({ ...catalog, source: { ...catalog.source, repository: "https://github.com/other/repo" } }, "minecraft"), null);
});

test("legacy GitHub failures retain their candidate identity and exact pins when adopted", () => {
  const preset = { id: "main", gameId: "minecraft", displayName: "Main", repository: source.configRepositoryUrl, commit: source.configCommit, profileDigest: input.profileDigest, releases: [], latestRelease: null, buildStatus: "unbuilt" as const };
  const catalog = { schema_version: 2, game: "minecraft", source: { repository: source.configRepositoryUrl, commit: source.configCommit, snapshot: { key: source.configSourceKey, sha256: source.configSourceSha256 } }, presets: [] };
  const entry = (name: string, seconds: number): DescribeExecutionCommandOutput => ({
    $metadata: {}, executionArn: `arn:aws:states:eu-central-1:123456789012:execution:spawnpoint-build-release:${name}`, stateMachineArn: "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-build-release",
    name, status: "FAILED", startDate: new Date(seconds * 1000), input: JSON.stringify({ ...source, profileId: "main", release: "39127124115.1" }),
  });
  const old = entry("release-39127124115-1-0", 1);
  const latest = entry("release-39127124115-2-0", 2);
  const adopted = legacyBuildCandidate(preset, catalog, [old, latest]);
  assert.equal(adopted?.release, "39127124115.1");
  assert.equal(adopted?.attempt, 2);
  assert.equal(adopted?.name, latest.name);
  assert.deepEqual(adopted?.source, source);
  const wrongSnapshot = { ...latest, input: JSON.stringify({ ...source, configCommit: "e".repeat(40), profileId: "main", release: "39127124115.1" }) };
  assert.equal(legacyBuildCandidate(preset, catalog, [wrongSnapshot]), null);
  assert.equal(legacyBuildCandidate({ ...preset, id: "other" }, catalog, [latest]), null);
});
