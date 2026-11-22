import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { objectKey } from "../src/control-plane/release-objects.ts";
import { releaseStateDocument, releaseStateKey, type ReleaseState } from "../src/control-plane/release-state.ts";
import {
  collectSources, dynamoRefsTableReader, s3BackupBucketReader, s3ReleaseBucketReader,
  type BackupBucketReader, type ReleaseBucketReader, type RefsTableReader,
} from "../src/control-plane/s3-release-marks.ts";
import type { TableItem } from "../src/control-plane/release-reconciler.ts";
import { worldRecordDocument, type WorldRecord } from "../src/control-plane/world-registry.ts";
import { cloudWatchMetrics, reconcile, type Metric, type ReconcilerDeps } from "../src/handlers/release-reconciler.ts";

const OPEN = `gen-${"a".repeat(32)}`;
const ARCHIVE = `worlds/world/archives/world-${OPEN}-20261101T000000Z-${"c".repeat(64)}.tar.zst`;
const NOW = new Date("2026-11-22T05:00:00.000Z");

function digest(n: number): string {
  return n.toString(16).padStart(64, "0");
}

const objectsManifest = {
  storage: { layout: "objects-v1" },
  server: { mods: [{ file: "a.jar", sha256: digest(1), bytes: 1 }], overrides: [{ path: "config/x.toml", sha256: digest(2), bytes: 1 }] },
  client: { kind: "mod-set", sha256: digest(3), bytes: 1, mods: [{ file: "c.jar", sha256: digest(4), bytes: 1 }] },
  packs: { server: { sha256: digest(5), bytes: 1 }, full: { sha256: digest(6), bytes: 1 } },
};

const record: WorldRecord = {
  worldId: "world", gameId: "minecraft", displayName: "World", status: "active", placement: "configured", connectivity: "zerotier",
  preset: { id: "preset", repository: "https://github.com/example/presets", commit: "0".repeat(40), profileDigest: "1".repeat(64) },
  currentGeneration: { id: OPEN, release: "1.0", createdAt: "2026-08-01T00:00:00.000Z", source: { kind: "preset" } },
  previousGenerations: [],
};

const pointer: ReleaseState = {
  worldId: "world", generationId: OPEN, desiredRelease: "1.1", activeRelease: "1.1", updatedAt: "2026-11-01T00:00:00.000Z",
  updatedBy: "op-1", source: "promote-commit",
};

const catalog = {
  schema_version: 2, game: "minecraft", source: { repository: "https://github.com/example/presets", commit: "0".repeat(40) },
  presets: [{ id: "preset", display_name: "Preset", profile_digest: "1".repeat(64), build_status: "ready", latest_release: "1.1", releases: ["1.0", "1.1"] }],
};

function documents(): Map<string, string> {
  return new Map([
    ["releases/minecraft/preset/1.0/manifest.json", JSON.stringify({ server: { mods: [] } })],
    ["releases/minecraft/preset/1.1/manifest.json", JSON.stringify(objectsManifest)],
    // A legacy override can be called manifest.json; it is not a release manifest.
    ["releases/minecraft/preset/1.0/overrides/config/manifest.json", "not json"],
    ["worlds/world/world.json", JSON.stringify(worldRecordDocument(record))],
    [releaseStateKey(pointer), JSON.stringify(releaseStateDocument(pointer))],
    ["presets/minecraft/catalog.json", JSON.stringify(catalog)],
  ]);
}

type Fakes = Readonly<{
  docs: Map<string, string>;
  objects: string[];
  versions: Array<{ key: string; versionId: string }>;
  heads: Map<string, { release: string | null; releaseSource: string | null; storedAt: string }>;
  items: TableItem[];
  failures: Set<string>;
}>;

function fakes(overrides: Partial<Fakes> = {}): Fakes {
  return {
    docs: documents(),
    objects: [2, 3, 4, 5, 6].map((n) => objectKey(digest(n))),
    versions: [{ key: ARCHIVE, versionId: "v1" }, { key: ARCHIVE, versionId: "v0" }, { key: "worlds/world/archives/notes.txt", versionId: "v1" }],
    heads: new Map([
      [`${ARCHIVE}#v1`, { release: "1.1", releaseSource: "active", storedAt: "2026-11-01T00:00:00.000Z" }],
      [`${ARCHIVE}#v0`, { release: "1.0", releaseSource: "origin", storedAt: "2026-10-01T00:00:00.000Z" }],
    ]),
    items: [],
    failures: new Set(),
    ...overrides,
  };
}

function deps(state: Fakes, sent: Metric[][] = []): ReconcilerDeps {
  const release: ReleaseBucketReader = {
    async listKeys(prefix) {
      if (state.failures.has(`list:${prefix}`)) throw Object.assign(new Error("denied"), { name: "AccessDenied" });
      return prefix === "objects/sha256/" ? state.objects : [...state.docs.keys()].filter((key) => key.startsWith(prefix));
    },
    async getText(key) { return state.docs.get(key) ?? null; },
  };
  const backup: BackupBucketReader = {
    async listVersions() {
      if (state.failures.has("versions")) throw Object.assign(new Error("denied"), { name: "AccessDenied" });
      return state.versions;
    },
    async head(key, versionId) {
      const metadata = state.heads.get(`${key}#${versionId}`);
      return metadata ?? null;
    },
  };
  const table: RefsTableReader = { async scan() { return state.items; } };
  return { ports: { release, backup, table }, metrics: { async put(metrics) { sent.push([...metrics]); } }, now: () => NOW };
}

function quiet<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const info = console.info;
  const error = console.error;
  console.info = (line: unknown) => { lines.push(String(line)); };
  console.error = () => {};
  return work().then((result) => ({ result, lines })).finally(() => { console.info = info; console.error = error; });
}

function values(metrics: readonly Metric[]): Record<string, number> {
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

test("a run reads, compares, logs one line per class and puts the metrics", async () => {
  const sent: Metric[][] = [];
  const { result: report, lines } = await quiet(() => reconcile({}, deps(fakes(), sent)));

  assert.equal(report.mode, "report");
  assert.equal(report.sweepable, false);
  assert.equal(report.complete, true);
  assert.equal(report.table_empty, true);
  assert.equal(report.generatedAt, NOW.toISOString());
  assert.equal(report.classes.missing_object.examples[0], `release#minecraft/preset/1.1 -> file#${digest(1)}`);

  assert.equal(sent.length, 1);
  assert.deepEqual(values(sent[0]!), {
    DangerousDiff: 1, MissingObject: 1, RunFailed: 0, OrphanObjects: 0, ExtraReferences: 0, CounterDrift: 0, UnregisteredReleases: 2, Incomplete: 0,
  });

  const parsed = lines.map((line) => JSON.parse(line) as { event: string; class?: string; count?: number });
  assert.equal(parsed.filter((line) => line.event === "release_reconciler_class").length, 9);
  assert.equal(parsed.find((line) => line.class === "missing_object")?.count, 1);
  assert.equal(parsed.filter((line) => line.event === "release_reconciler_summary").length, 1);
});

test("the schedule's empty event, no event and the report mode all run", async () => {
  for (const event of [{}, undefined, { mode: "report" }]) {
    const sent: Metric[][] = [];
    await quiet(() => reconcile(event, deps(fakes(), sent)));
    assert.equal(sent.length, 1);
  }
});

test("an unknown mode is rejected before anything is read or put", async () => {
  const sent: Metric[][] = [];
  let reads = 0;
  const base = deps(fakes(), sent);
  const counted: ReconcilerDeps = { ...base, ports: { ...base.ports, table: { async scan() { reads += 1; return []; } } } };
  for (const mode of ["sweep", "", "REPORT", 1]) {
    await assert.rejects(() => reconcile({ mode }, counted), /unsupported_mode/);
  }
  assert.equal(reads, 0);
  assert.deepEqual(sent, []);
});

test("a failed source read marks the run incomplete, still reports, and does not set RunFailed", async () => {
  const sent: Metric[][] = [];
  const { result: report } = await quiet(() => reconcile({}, deps(fakes({ failures: new Set(["versions"]) }), sent)));
  assert.equal(report.complete, false);
  assert.equal(report.sweepable, false);
  assert.deepEqual(report.failures.map((failure) => failure.source), ["archives"]);
  assert.equal(report.classes.missing_object.count, 1, "what could be compared is still reported");
  assert.equal(values(sent[0]!).Incomplete, 1);
  assert.equal(values(sent[0]!).RunFailed, 0);
});

test("a manifest that does not parse is a source failure; an override named manifest.json is not read", async () => {
  const state = fakes();
  state.docs.set("releases/minecraft/preset/1.2/manifest.json", "{not json");
  const { result: report } = await quiet(() => reconcile({}, deps(state)));
  assert.equal(report.complete, false);
  assert.deepEqual(report.failures.map((failure) => `${failure.source} ${failure.subject}`), ["manifest releases/minecraft/preset/1.2/manifest.json"]);
});

test("a run that throws puts RunFailed and rethrows the original error", async () => {
  const sent: Metric[][] = [];
  const failing: ReconcilerDeps = { ...deps(fakes(), sent), now: () => { throw new Error("clock_broken"); } };
  await assert.rejects(() => quiet(() => reconcile({}, failing)), /clock_broken/);
  assert.deepEqual(sent, [[{ name: "RunFailed", value: 1 }]]);

  const noMetrics: ReconcilerDeps = { ...failing, metrics: { async put() { throw new Error("cloudwatch_down"); } } };
  await assert.rejects(() => quiet(() => reconcile({}, noMetrics)), /clock_broken/);
});

test("the CloudWatch sink puts counts in the reconciler's own namespace", async () => {
  const inputs: Array<Record<string, unknown>> = [];
  const sink = cloudWatchMetrics({ send: async (command: { input: Record<string, unknown> }) => { inputs.push(command.input); return {}; } } as never);
  await sink.put([{ name: "DangerousDiff", value: 2 }]);
  assert.deepEqual(inputs, [{ Namespace: "Spawnpoint/ReleaseReconciler", MetricData: [{ MetricName: "DangerousDiff", Value: 2, Unit: "Count" }] }]);
});

// The adapters: only list, get, head and scan reach AWS.

test("the read ports expose list, get, head and scan, and nothing that writes", () => {
  const send = async () => ({});
  assert.deepEqual(Object.keys(s3ReleaseBucketReader({ send } as never, "b")).sort(), ["getText", "listKeys"]);
  assert.deepEqual(Object.keys(s3BackupBucketReader({ send } as never, "b")).sort(), ["head", "listVersions"]);
  assert.deepEqual(Object.keys(dynamoRefsTableReader({ send } as never, "t")), ["scan"]);
});

test("the adapters send only list, get, head and scan commands, page through every listing and name the version", async () => {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    sent.push({ name: command.constructor.name, input: command.input });
    switch (command.constructor.name) {
      case "ListObjectsV2Command":
        return command.input.ContinuationToken === undefined
          ? { Contents: [{ Key: "a" }], IsTruncated: true, NextContinuationToken: "t2" }
          : { Contents: [{ Key: "b" }], IsTruncated: false };
      case "GetObjectCommand":
        throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      case "ListObjectVersionsCommand":
        return command.input.KeyMarker === undefined
          ? { Versions: [{ Key: "k", VersionId: "1" }], IsTruncated: true, NextKeyMarker: "k", NextVersionIdMarker: "1" }
          : { Versions: [{ Key: "k", VersionId: "2" }], DeleteMarkers: [{ Key: "k", VersionId: "3" }], IsTruncated: false };
      case "HeadObjectCommand":
        return { Metadata: { release: "1.1", "release-source": "active" }, LastModified: new Date("2026-11-01T00:00:00Z") };
      default:
        return command.input.ExclusiveStartKey === undefined
          ? { Items: [{ pk: "a" }], LastEvaluatedKey: { pk: "a" } }
          : { Items: [{ pk: "b" }] };
    }
  };
  const release = s3ReleaseBucketReader({ send } as never, "releases");
  const backup = s3BackupBucketReader({ send } as never, "backups");
  const table = dynamoRefsTableReader({ send } as never, "refs");

  assert.deepEqual(await release.listKeys("releases/"), ["a", "b"]);
  assert.equal(await release.getText("missing"), null);
  assert.deepEqual(await backup.listVersions("worlds/"), [{ key: "k", versionId: "1" }, { key: "k", versionId: "2" }]);
  assert.deepEqual(await backup.head("k", "2"), { release: "1.1", releaseSource: "active", storedAt: "2026-11-01T00:00:00.000Z" });
  assert.deepEqual(await table.scan(), [{ pk: "a" }, { pk: "b" }]);

  assert.deepEqual([...new Set(sent.map((command) => command.name))].sort(), [
    "GetObjectCommand", "HeadObjectCommand", "ListObjectVersionsCommand", "ListObjectsV2Command", "ScanCommand",
  ]);
  assert.deepEqual(sent.find((command) => command.name === "HeadObjectCommand")?.input, { Bucket: "backups", Key: "k", VersionId: "2" });
});

test("collect reads current and noncurrent archive versions and ignores keys that are not archives", async () => {
  const collected = await collectSources(deps(fakes()).ports);
  assert.deepEqual(collected.input.archives.map((archive) => archive.versionId).sort(), ["v0", "v1"]);
  assert.equal(collected.input.manifests.length, 2);
  assert.equal(collected.input.worlds.length, 1);
  assert.equal(collected.input.pointers.length, 1);
  assert.equal(collected.input.catalogs.length, 1);
  assert.deepEqual(collected.input.failures, []);
});

test("the reconciler modules contain no write call to S3, DynamoDB or any other service but the metric put", async () => {
  const files = [
    "../src/control-plane/release-reconciler.ts",
    "../src/control-plane/s3-release-marks.ts",
    "../src/handlers/release-reconciler.ts",
  ];
  const write = /\b(Put|Delete|Copy|Update|Restore|Upload|Complete|Abort)\w*(Object|Item|Objects|Items|Version|Table)\w*Command\b|TransactWrite|BatchWrite|S3WorldRepository|S3ReleaseStateStore/;
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, write, file);
  }
  const handler = await readFile(new URL(files[2]!, import.meta.url), "utf8");
  assert.deepEqual([...handler.matchAll(/new (\w+Command)\(/g)].map((match) => match[1]), ["PutMetricDataCommand"]);
});
