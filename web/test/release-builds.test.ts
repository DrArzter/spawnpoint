import assert from "node:assert/strict";
import test from "node:test";
import { releaseBuildCopy, releaseBuildExpectation } from "../src/core/release-builds.ts";
import type { Preset } from "../src/model.ts";

const preset: Preset = { id: "main", displayName: "Main", repository: "https://github.com/example/presets", commit: "a".repeat(40), profileDigest: "b".repeat(64), releases: [], latestRelease: null, buildStatus: "unbuilt" };
test("new, retry and resume share one label and source expectation contract", () => {
  assert.equal(releaseBuildCopy(preset).label, "Build release");
  assert.deepEqual(releaseBuildExpectation(preset), { profileDigest: preset.profileDigest });
  for (const state of ["starting", "failed"] as const) {
    const failed: Preset = { ...preset, build: { state, release: "1.0", attempt: 2, requestedAt: "2026-10-18T12:00:00Z", profileDigest: "c".repeat(64) } };
    assert.match(releaseBuildCopy(failed).title, /release 1\.0/);
    assert.equal(releaseBuildCopy(failed).label, state === "starting" ? "Resume build" : "Retry build");
    assert.deepEqual(releaseBuildExpectation(failed), { profileDigest: "c".repeat(64), retryRelease: "1.0" });
  }
  assert.equal(releaseBuildCopy({ ...preset, releases: ["1.0"] }).label, "Build new release");
});
