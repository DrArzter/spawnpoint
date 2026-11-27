import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

type Retrier = { ErrorEquals: string[]; IntervalSeconds?: number; MaxAttempts?: number; BackoffRate?: number };

type State = {
  Type: string;
  Resource?: string;
  Retry?: Retrier[];
  Branches?: Machine[];
  Iterator?: Machine;
  ItemProcessor?: Machine;
};

type Machine = { States: Record<string, State> };

const LAMBDA_RETRY: Retrier = {
  ErrorEquals: [
    "Lambda.ServiceException",
    "Lambda.AWSLambdaException",
    "Lambda.SdkClientException",
    "Lambda.TooManyRequestsException",
  ],
  IntervalSeconds: 2,
  MaxAttempts: 3,
  BackoffRate: 2,
};

// Step Functions names an aws-sdk error "<Service>.<Code>Exception", adding the
// suffix when the service omits it. The bare EC2 code is kept as well.
const THROTTLE_RETRY: Record<string, Retrier> = {
  ec2: {
    ErrorEquals: ["Ec2.RequestLimitExceededException", "Ec2.RequestLimitExceeded"],
    IntervalSeconds: 2,
    MaxAttempts: 3,
    BackoffRate: 2,
  },
  ssm: {
    ErrorEquals: ["Ssm.ThrottlingException"],
    IntervalSeconds: 2,
    MaxAttempts: 3,
    BackoffRate: 2,
  },
};

const CREATE_FLEET = "arn:aws:states:::aws-sdk:ec2:createFleet";
const workflows = new URL("../../workflows/", import.meta.url);

// The same substitutions the per-machine tests make before parsing.
function render(template: string): Machine {
  return JSON.parse(
    template
      .replaceAll("${allowed_instance_types}", JSON.stringify(["m7i-flex.*", "r7i.*"]))
      .replaceAll("${grace_period_seconds}", "600")
      .replaceAll("${headroom_mib}", "0")
      .replaceAll("${max_keep_polls}", "288")
      .replaceAll("${warm_retention_seconds}", "1209600")
      .replaceAll(/\$\{[^}]+\}/g, "arn:aws:test:eu-central-1:123456789012:resource"),
  ) as Machine;
}

async function v2Machines(): Promise<Array<[string, Machine]>> {
  const names = (await readdir(workflows)).filter((name) => /-v2.*\.tftpl$/.test(name)).sort();
  assert.ok(names.length >= 4, `expected the V2 workflows, found ${names.join(", ")}`);
  return Promise.all(names.map(async (name) => [name, render(await readFile(new URL(name, workflows), "utf8"))] as [string, Machine]));
}

function* tasks(machine: Machine, path = ""): Generator<[string, State]> {
  for (const [name, state] of Object.entries(machine.States)) {
    const here = path ? `${path} / ${name}` : name;
    if (state.Type === "Task") yield [here, state];
    for (const branch of state.Branches ?? []) yield* tasks(branch, here);
    for (const nested of [state.Iterator, state.ItemProcessor]) if (nested) yield* tasks(nested, here);
  }
}

function sdkService(resource: string | undefined): string | undefined {
  return resource?.match(/^arn:aws:states:::aws-sdk:([a-z0-9]+):/)?.[1];
}

test("every V2 Lambda task retries the transient Lambda service errors", async () => {
  let count = 0;
  for (const [file, machine] of await v2Machines()) {
    for (const [name, state] of tasks(machine)) {
      if (state.Resource !== "arn:aws:states:::lambda:invoke") continue;
      count += 1;
      assert.deepEqual(state.Retry, [LAMBDA_RETRY], `${file}: ${name}`);
    }
  }
  assert.ok(count > 0);
});

// Retries beyond throttling, each for a named reason. The attach meets a host
// launched a second ago, still pending (ADR-0102, the 2026-11-27 fault test).
const EXTRA_RETRY: Readonly<Record<string, readonly unknown[]>> = {
  "Attach Session Volume": [{ ErrorEquals: ["Ec2.Ec2Exception"], IntervalSeconds: 6, MaxAttempts: 10, BackoffRate: 1 }],
};

test("every V2 EC2 and SSM call retries throttling, except the fleet launch", async () => {
  let count = 0;
  for (const [file, machine] of await v2Machines()) {
    for (const [name, state] of tasks(machine)) {
      const service = sdkService(state.Resource);
      if (service !== "ec2" && service !== "ssm") continue;
      if (state.Resource === CREATE_FLEET) continue;
      count += 1;
      assert.deepEqual(state.Retry, [THROTTLE_RETRY[service], ...(EXTRA_RETRY[name] ?? [])], `${file}: ${name}`);
    }
  }
  assert.ok(count > 0);
});

test("the fleet launch is never retried until it carries a client token", async () => {
  const launches = (await v2Machines()).flatMap(([file, machine]) =>
    [...tasks(machine)].filter(([, state]) => state.Resource === CREATE_FLEET).map(([name, state]) => ({ file, name, state })));
  // The on-demand launch and, ADR-0102, the Spot launch with its on-demand fallback.
  assert.deepEqual(launches.map(({ name }) => name).sort(), ["Launch Host", "Launch Spot Host"]);
  for (const launch of launches) assert.equal(launch.state.Retry, undefined, `${launch.file}: ${launch.name}`);
});
