import assert from "node:assert/strict";
import test from "node:test";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeExecutionCommand, ListExecutionsCommand, SFNClient } from "@aws-sdk/client-sfn";
import { awsControlPlaneSources } from "../src/control-plane/aws.ts";

process.env.OPERATION_STATE_MACHINES = JSON.stringify([{ type: "start", arn: "arn:aws:states:eu-central-1:123456789012:stateMachine:start" }]);

const executionArn = (name: string) => `arn:aws:states:eu-central-1:123456789012:execution:start:${name}`;
const execution = (name: string, minute: number) => ({ name, executionArn: executionArn(name), startDate: new Date(Date.UTC(2026, 10, 21, 12, minute)) });

test("running operations are read from every page, and each world is described once", async (t) => {
  const pages: Record<string, { executions: ReturnType<typeof execution>[]; nextToken?: string }> = {
    first: { executions: [execution("one", 1)], nextToken: "page-2" },
    "page-2": { executions: [execution("two", 2)] },
  };
  const tokens: (string | undefined)[] = [];
  const described: string[] = [];
  t.mock.method(SFNClient.prototype, "send", async (command: unknown) => {
    if (command instanceof ListExecutionsCommand) {
      tokens.push(command.input.nextToken);
      return pages[command.input.nextToken ?? "first"];
    }
    if (command instanceof DescribeExecutionCommand) {
      const arn = command.input.executionArn!;
      described.push(arn);
      return { input: JSON.stringify({ worldId: `world-${arn.split(":").at(-1)}` }) };
    }
    throw new Error("unexpected command");
  });

  const first = await awsControlPlaneSources.listRunningOperations();
  assert.deepEqual(tokens, [undefined, "page-2"]);
  assert.deepEqual(first.map((operation) => [operation.id, operation.worldId]), [["two", "world-two"], ["one", "world-one"]]);

  await awsControlPlaneSources.listRunningOperations();
  assert.deepEqual(described.sort(), [executionArn("one"), executionArn("two")]);
});

test("a world that could not be read is not cached", async (t) => {
  let attempts = 0;
  t.mock.method(SFNClient.prototype, "send", async (command: unknown) => {
    if (command instanceof ListExecutionsCommand) return { executions: [execution("flaky", 3)] };
    attempts += 1;
    if (attempts === 1) throw new Error("throttled");
    return { input: JSON.stringify({ worldId: "world-flaky" }) };
  });
  t.mock.method(console, "warn", () => {});

  assert.equal((await awsControlPlaneSources.listRunningOperations())[0]?.worldId, null);
  assert.equal((await awsControlPlaneSources.listRunningOperations())[0]?.worldId, "world-flaky");
  assert.equal(attempts, 2);
});

test("host metrics add memory from the watchdog's namespace beside the free EC2 series", async (t) => {
  let queries: NonNullable<GetMetricDataCommand["input"]["MetricDataQueries"]> = [];
  t.mock.method(CloudWatchClient.prototype, "send", async (command: unknown) => {
    assert.ok(command instanceof GetMetricDataCommand);
    queries = command.input.MetricDataQueries ?? [];
    return { MetricDataResults: [{ Id: "memory", Timestamps: [new Date(Date.UTC(2026, 10, 21, 12))], Values: [41.5] }] };
  });

  const metrics = await awsControlPlaneSources.readHostMetrics!("i-0abc", 6);

  const memory = queries.find((query) => query.Id === "memory")?.MetricStat;
  assert.equal(memory?.Metric?.Namespace, "Spawnpoint/Host");
  assert.equal(memory?.Metric?.MetricName, "MemoryUsedPercent");
  assert.deepEqual(memory?.Metric?.Dimensions, [{ Name: "InstanceId", Value: "i-0abc" }]);
  assert.equal(memory?.Stat, "Average");
  assert.equal(queries.find((query) => query.Id === "cpu")?.MetricStat?.Metric?.Namespace, "AWS/EC2");
  assert.deepEqual(metrics.series.map((series) => series.id), ["cpu", "memory", "networkIn", "networkOut"]);
  assert.deepEqual(metrics.series.find((series) => series.id === "memory")?.points, [{ at: "2026-11-21T12:00:00.000Z", value: 41.5 }]);
  assert.deepEqual(metrics.series.find((series) => series.id === "cpu")?.points, []);
});
