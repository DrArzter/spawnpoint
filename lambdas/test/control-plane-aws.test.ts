import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeInstancesCommand, DescribeInstanceTypesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeExecutionCommand, ListExecutionsCommand, SFNClient } from "@aws-sdk/client-sfn";
import { awsControlPlaneSources } from "../src/control-plane/aws.ts";
import { createHostShapeReader } from "../src/control-plane/aws-host-shapes.ts";

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

// EC2 knows `i-0abc` as an m7i-flex.large: 2 vCPUs and 8 GiB.
function describeShapes(t: TestContext, known: Readonly<Record<string, string>> = { "i-0abc": "m7i-flex.large" }) {
  const shapes: Record<string, { vcpu: number; memoryMiB: number }> = { "m7i-flex.large": { vcpu: 2, memoryMiB: 8192 }, "r7i.xlarge": { vcpu: 4, memoryMiB: 32768 } };
  const calls: string[] = [];
  t.mock.method(EC2Client.prototype, "send", async (command: unknown) => {
    if (command instanceof DescribeInstancesCommand) {
      calls.push("instances");
      const ids = command.input.Filters?.find((filter) => filter.Name === "instance-id")?.Values ?? [];
      return { Reservations: [{ Instances: ids.filter((id) => known[id]).map((id) => ({ InstanceId: id, InstanceType: known[id] })) }] };
    }
    if (command instanceof DescribeInstanceTypesCommand) {
      calls.push(`types:${(command.input.InstanceTypes ?? []).join(",")}`);
      return { InstanceTypes: (command.input.InstanceTypes ?? []).map((type) => ({ InstanceType: type, VCpuInfo: { DefaultVCpus: shapes[type]!.vcpu }, MemoryInfo: { SizeInMiB: shapes[type]!.memoryMiB } })) };
    }
    throw new Error("unexpected command");
  });
  return calls;
}

test("host metrics add memory from the watchdog's namespace beside the free EC2 series", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 21, 14) });
  describeShapes(t, {});
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
  const memoryPoints = metrics.series.find((series) => series.id === "memory")?.points ?? [];
  assert.deepEqual(memoryPoints.filter((point) => point.value !== null), [{ at: "2026-11-21T12:00:00.000Z", value: 41.5 }]);
  assert.ok(metrics.series.find((series) => series.id === "cpu")?.points.every((point) => point.value === null));
});

test("a host that was off keeps its gap: every series spans the window, null where CloudWatch has nothing", async (t) => {
  const now = Date.UTC(2026, 10, 22, 12, 0);
  t.mock.timers.enable({ apis: ["Date"], now });
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000);
  describeShapes(t, {});
  t.mock.method(CloudWatchClient.prototype, "send", async () => ({
    // Running for the last two hours only, at the 6-hour range's 5-minute grain.
    MetricDataResults: [{ Id: "cpu", Timestamps: [at(2), at(1), at(0.5)], Values: [40, 50, 60] }],
  }));

  const metrics = await awsControlPlaneSources.readHostMetrics!("i-0abc", 6);

  const lengths = new Set(metrics.series.map((series) => series.points.length));
  assert.deepEqual([...lengths], [72], "6 hours of 5-minute periods, the same for every series");
  const cpu = metrics.series.find((series) => series.id === "cpu")!.points;
  assert.equal(cpu.filter((point) => point.value !== null).length, 3);
  assert.equal(cpu[0]!.value, null, "the start of the window, when the host was off");
  assert.deepEqual(cpu.find((point) => point.at === at(1).toISOString()), { at: at(1).toISOString(), value: 50 });
});

test("CPU and memory stay percentages and carry the host's cores and bytes as capacity", async (t) => {
  const now = Date.UTC(2026, 10, 22, 12, 0);
  t.mock.timers.enable({ apis: ["Date"], now });
  describeShapes(t);
  const at = new Date(now - 3_600_000);
  t.mock.method(CloudWatchClient.prototype, "send", async () => ({
    MetricDataResults: [{ Id: "cpu", Timestamps: [at], Values: [25] }, { Id: "memory", Timestamps: [at], Values: [50] }],
  }));

  const metrics = await awsControlPlaneSources.readHostMetrics!("i-0abc", 6);

  const series = (id: string) => metrics.series.find((item) => item.id === id)!;
  assert.deepEqual(series("cpu").points.find((point) => point.value !== null), { at: at.toISOString(), value: 25, capacity: 2 });
  assert.equal(series("cpu").capacityUnit, "cores");
  assert.deepEqual(series("memory").points.find((point) => point.value !== null), { at: at.toISOString(), value: 50, capacity: 8 * 1024 ** 3 });
  assert.equal(series("memory").capacityUnit, "bytes");
  assert.equal(series("cpu").points[0]?.capacity, undefined, "an empty slot has no host, so no capacity");
  assert.equal(series("networkIn").capacityUnit, undefined);
});

test("a host EC2 no longer describes gives its readings no capacity", async (t) => {
  const now = Date.UTC(2026, 10, 22, 12, 0);
  t.mock.timers.enable({ apis: ["Date"], now });
  describeShapes(t, {});
  t.mock.method(CloudWatchClient.prototype, "send", async () => ({ MetricDataResults: [{ Id: "cpu", Timestamps: [new Date(now - 3_600_000)], Values: [25] }] }));

  const metrics = await awsControlPlaneSources.readHostMetrics!("i-0gone", 6);

  const cpu = metrics.series.find((item) => item.id === "cpu")!;
  assert.deepEqual(cpu.points.find((point) => point.value !== null), { at: new Date(now - 3_600_000).toISOString(), value: 25 });
  assert.equal(cpu.capacityUnit, "cores", "the series still says what a capacity would be in");
});

test("network is a rate: steady traffic reads the same per second over six hours and over a week", async (t) => {
  const now = Date.UTC(2026, 10, 22, 12, 0);
  t.mock.timers.enable({ apis: ["Date"], now });
  describeShapes(t, {});
  const bytesPerSecond = 1000;
  // CloudWatch sums each period, so a longer period holds more bytes.
  t.mock.method(CloudWatchClient.prototype, "send", async (command: unknown) => {
    assert.ok(command instanceof GetMetricDataCommand);
    const period = command.input.MetricDataQueries![0]!.MetricStat!.Period!;
    const at = new Date(Math.floor((now - 2 * 3_600_000) / (period * 1000)) * period * 1000);
    return { MetricDataResults: [{ Id: "networkIn", Timestamps: [at], Values: [bytesPerSecond * period] }] };
  });

  const rateOf = (metrics: Awaited<ReturnType<NonNullable<typeof awsControlPlaneSources.readHostMetrics>>>) => {
    const series = metrics.series.find((item) => item.id === "networkIn")!;
    assert.equal(series.unit, "bytesPerSecond");
    return series.points.find((point) => point.value !== null)?.value;
  };
  const sixHours = await awsControlPlaneSources.readHostMetrics!("i-0abc", 6);
  const week = await awsControlPlaneSources.readHostMetrics!("i-0abc", 168);
  assert.equal(sixHours.periodSeconds, 300);
  assert.equal(week.periodSeconds, 3600);
  assert.equal(rateOf(sixHours), bytesPerSecond);
  assert.equal(rateOf(week), bytesPerSecond);
});

test("a host's shape is read from its instance type, once per type, and a failed read gives none", async (t) => {
  const calls = describeShapes(t, { "i-0abc": "m7i-flex.large", "i-0def": "r7i.xlarge", "i-0ghi": "m7i-flex.large" });
  const ec2 = new EC2Client({});
  const read = createHostShapeReader(ec2);

  const first = await read(["i-0abc", "i-0def", "i-0gone"]);
  assert.deepEqual(first.get("i-0abc"), { instanceType: "m7i-flex.large", vcpu: 2, memoryMiB: 8192 });
  assert.deepEqual(first.get("i-0def"), { instanceType: "r7i.xlarge", vcpu: 4, memoryMiB: 32768 });
  assert.equal(first.has("i-0gone"), false);
  await read(["i-0ghi"]);
  assert.deepEqual(calls, ["instances", "types:m7i-flex.large,r7i.xlarge", "instances"], "a known type is not described again");

  t.mock.method(ec2, "send", async () => { throw new Error("denied"); });
  t.mock.method(console, "warn", () => {});
  assert.equal((await read(["i-0abc"])).size, 0);
});
