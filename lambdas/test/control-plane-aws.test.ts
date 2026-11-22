import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
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
      if (command.input.statusFilter !== "RUNNING") return { executions: [] };
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
    if (command instanceof ListExecutionsCommand) return { executions: command.input.statusFilter === "RUNNING" ? [execution("flaky", 3)] : [] };
    attempts += 1;
    if (attempts === 1) throw new Error("throttled");
    return { input: JSON.stringify({ worldId: "world-flaky" }) };
  });
  t.mock.method(console, "warn", () => {});

  assert.equal((await awsControlPlaneSources.listRunningOperations())[0]?.worldId, null);
  assert.equal((await awsControlPlaneSources.listRunningOperations())[0]?.worldId, "world-flaky");
  assert.equal(attempts, 2);
});

// A finished run of `world` that took `seconds`; `index` makes it older the larger it is.
const finished = (world: string, index: number, seconds: number) => {
  const start = Date.UTC(2026, 10, 20, 12) - index * 3_600_000;
  const name = `${world}-${index}`;
  return { name, executionArn: executionArn(name), startDate: new Date(start), stopDate: new Date(start + seconds * 1000) };
};

// Histories are kept per container for minutes, so each test reads at its own hour, after any earlier read.
let hour = 0;
function mockHistory(t: TestContext, running: ReturnType<typeof execution>[], history: ReturnType<typeof finished>[]) {
  hour += 1;
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2030, 0, 1, hour) });
  const calls = { succeeded: 0, described: 0 };
  t.mock.method(SFNClient.prototype, "send", async (command: unknown) => {
    if (command instanceof ListExecutionsCommand) {
      if (command.input.statusFilter === "RUNNING") return { executions: running };
      assert.equal(command.input.statusFilter, "SUCCEEDED");
      assert.equal(command.input.maxResults, 50);
      calls.succeeded += 1;
      return { executions: history };
    }
    assert.ok(command instanceof DescribeExecutionCommand);
    calls.described += 1;
    return { input: JSON.stringify({ worldId: command.input.executionArn!.split(":").at(-1)!.replace(/-\d+$/, "") }) };
  });
  return calls;
}

test("a running operation carries the average of its world's newest ten finished runs", async (t) => {
  const history = [
    // Newest first: ten for the world, then older ones that must not count.
    ...Array.from({ length: 10 }, (_, index) => finished("eta-world", index, 60 + index * 10)),
    finished("eta-world", 10, 3000),
    finished("other-world", 11, 5),
  ];
  mockHistory(t, [{ ...execution("eta-world-run", 5), name: "eta-world-run", executionArn: executionArn("eta-world") }], history);

  const [operation] = await awsControlPlaneSources.listRunningOperations();

  assert.equal(operation?.worldId, "eta-world");
  assert.equal(operation?.expectedSamples, 10);
  assert.equal(operation?.expectedSeconds, 105);
});

test("a world with fewer than three finished runs has no expectation", async (t) => {
  mockHistory(t, [{ ...execution("thin-run", 6), executionArn: executionArn("thin-world") }], [
    finished("thin-world", 0, 90), finished("thin-world", 1, 100), finished("busy-world", 2, 10), finished("busy-world", 3, 10), finished("busy-world", 4, 10),
  ]);

  const [operation] = await awsControlPlaneSources.listRunningOperations();

  assert.equal(operation?.worldId, "thin-world");
  assert.equal("expectedSeconds" in (operation ?? {}), false);
});

test("the history is read only while something runs, and kept between polls", async (t) => {
  const running = [{ ...execution("cache-run", 7), executionArn: executionArn("cache-world") }];
  const history = [finished("cache-world", 0, 30), finished("cache-world", 1, 40), finished("cache-world", 2, 50)];
  const calls = mockHistory(t, running, history);

  await awsControlPlaneSources.listRunningOperations();
  const afterFirst = { ...calls };
  const [again] = await awsControlPlaneSources.listRunningOperations();

  assert.equal(afterFirst.succeeded, 1);
  assert.equal(calls.succeeded, 1);
  assert.equal(calls.described, afterFirst.described);
  assert.equal(again?.expectedSeconds, 40);

  running.length = 0;
  const idle = { ...calls };
  assert.deepEqual(await awsControlPlaneSources.listRunningOperations(), []);
  assert.equal(calls.succeeded, idle.succeeded);
});

test("a history that cannot be read leaves the operation without an expectation", async (t) => {
  hour += 1;
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2030, 0, 1, hour) });
  t.mock.method(SFNClient.prototype, "send", async (command: unknown) => {
    if (command instanceof ListExecutionsCommand) {
      if (command.input.statusFilter === "RUNNING") return { executions: [{ ...execution("denied-run", 8), executionArn: executionArn("denied-world") }] };
      throw new Error("denied");
    }
    return { input: JSON.stringify({ worldId: "denied-world" }) };
  });
  t.mock.method(console, "warn", () => {});

  const [operation] = await awsControlPlaneSources.listRunningOperations();

  assert.equal(operation?.worldId, "denied-world");
  assert.equal(operation?.expectedSeconds, undefined);
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
