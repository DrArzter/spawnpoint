import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { initialLifecycleRecord, type LifecycleRecord } from "../src/domain/lifecycle.ts";
import type { SessionHost } from "../src/domain/session-history.ts";
import { awsControlPlaneSources } from "../src/control-plane/aws.ts";
import type { ControlPlaneSources } from "../src/control-plane/read-model.ts";
import type { WorldRecord } from "../src/control-plane/world-registry.ts";
import { worldMetrics } from "../src/handlers/api/metrics.ts";

process.env.OPERATION_STATE_MACHINES = JSON.stringify(["start", "stop", "world"].map((type) => ({ type, arn: `arn:aws:states:eu-central-1:123456789012:stateMachine:${type}` })));
process.env.LIFECYCLE_TABLE_NAME = "lifecycle";

const NOW = Date.UTC(2026, 10, 21, 14, 0);
const minutes = (value: number) => new Date(NOW + value * 60_000);
const world: WorldRecord = {
  gameId: "minecraft", worldId: "prominence", displayName: "Prominence", status: "active", placement: "fleet", connectivity: "zerotier",
  preset: { id: "industrial", repository: "https://github.com/example/config", commit: "a".repeat(40), profileDigest: "b".repeat(64) },
  currentGeneration: { id: `gen-${"c".repeat(32)}`, release: "1.2", createdAt: "2026-10-18T00:00:00Z", source: { kind: "preset" } },
  previousGenerations: [],
};

function scenario(t: TestContext, options: Readonly<{ entries: readonly SessionHost[]; live?: LifecycleRecord; datapoints: Record<string, readonly [Date, number][]> }>) {
  const sources = awsControlPlaneSources as Required<ControlPlaneSources>;
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const queries: string[][] = [];
  t.mock.method(sources, "listHosts", async () => []);
  t.mock.method(sources, "listPresets", async () => []);
  t.mock.method(sources, "listWorldRecords", async () => [world]);
  t.mock.method(sources, "readLifecycle", async (key: string) => key === "world#prominence" ? options.live ?? null : null);
  t.mock.method(sources, "readWorldSessionHosts", async () => options.entries);
  // The live session's placement comes from the host records.
  t.mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [{ host: { hostId: "i-bbbb2222", reservations: [{ sessionId: "s2", slot: 0 }] } }],
  }));
  t.mock.method(CloudWatchClient.prototype, "send", async (command: unknown) => {
    assert.ok(command instanceof GetMetricDataCommand);
    const asked = command.input.MetricDataQueries ?? [];
    queries.push(asked.map((query) => query.Id ?? ""));
    return { MetricDataResults: asked.flatMap((query) => {
      const hostId = query.MetricStat?.Metric?.Dimensions?.[0]?.Value ?? "";
      const points = query.MetricStat?.Metric?.MetricName === "CPUUtilization" ? options.datapoints[hostId] ?? [] : [];
      return [{ Id: query.Id, Timestamps: points.map(([at]) => at), Values: points.map(([, value]) => value) }];
    }) };
  });
  return queries;
}

const earlier: SessionHost = { sessionId: "s1", hostId: "i-aaaa1111", startedAt: minutes(-300).toISOString(), endedAt: minutes(-240).toISOString() };

test("a stopped world shows the hosts of its earlier sessions in one CloudWatch call", async (t) => {
  const queries = scenario(t, { entries: [earlier], datapoints: { "i-aaaa1111": [[minutes(-290), 12], [minutes(-250), 18]] } });
  const reply = await worldMetrics("minecraft", "prominence", "6h");
  assert.equal(reply.statusCode, 200);
  const body = JSON.parse(reply.body) as { series: { id: string; points: { value: number | null }[] }[]; pendingFrom?: string };
  assert.equal(queries.length, 1, "one GetMetricData for all hosts");
  assert.deepEqual(body.series.find((series) => series.id === "cpu")?.points.filter((point) => point.value !== null).map((point) => point.value), [12, 18]);
  assert.equal(body.pendingFrom, undefined, "a stopped world has nothing pending");
});

test("two sessions on two hosts are read together, and the running session's newest slots are pending", async (t) => {
  const live = { ...initialLifecycleRecord("world#prominence", 1), activeWorldId: "prominence", activeSessionId: "s2", desiredState: "running" as const, observedState: "ready" as const, readyAtEpochSeconds: Math.floor(minutes(-60).getTime() / 1000) };
  const second: SessionHost = { sessionId: "s2", hostId: "i-bbbb2222", startedAt: minutes(-60).toISOString(), endedAt: null };
  const queries = scenario(t, { entries: [earlier, second], live, datapoints: {
    "i-aaaa1111": [[minutes(-290), 12]],
    "i-bbbb2222": [[minutes(-55), 40], [minutes(-30), 45]],
  } });
  const body = JSON.parse((await worldMetrics("minecraft", "prominence", "6h")).body) as { series: { id: string; points: { at: string; value: number | null }[] }[]; pendingFrom?: string };
  assert.equal(queries[0]?.length, 8, "four series for each of two hosts");
  const cpu = body.series.find((series) => series.id === "cpu")!.points.filter((point) => point.value !== null).map((point) => point.value);
  assert.deepEqual(cpu, [12, 40, 45]);
  assert.ok(body.pendingFrom !== undefined && Date.parse(body.pendingFrom) > minutes(-30).getTime(), "the slots after the newest reading wait for CloudWatch");
});

test("a world with no session in the window has no metrics to show", async (t) => {
  scenario(t, { entries: [], datapoints: {} });
  assert.equal((await worldMetrics("minecraft", "prominence", "6h")).statusCode, 409);
});
