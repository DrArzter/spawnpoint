// PROTOTYPE — throwaway. Not deployed, not imported by anything under src/.
//
// The question it answers: does placing several worlds on one host save money
// for this group, and when? It replays scripted evenings through the real
// placement module and prints what the fleet did, what it would have cost, and
// how many starts landed on a host already up. The control plane never sees a
// price: a launch states requirements and EC2 Fleet picks the cheapest type
// that meets them. This replay stands in for EC2 with a small price table, so
// the rates below are a forecast input, not something the code depends on.
//
//   node lambdas/prototype/placement-evening.ts
//
// Delete it, or fold its verdict into docs/costs.md, once the decision is made.

import {
  drainDecision,
  headroomLaunch,
  holdsHeadroom,
  markReady,
  markTerminating,
  newHost,
  place,
  release,
  reserve,
} from "../src/domain/placement.ts";
import type { Footprint, HostRecord, HostShape, LaunchRequirements } from "../src/domain/placement.ts";

type PricedShape = HostShape & { usdPerHour: number };

// What EC2 Fleet would have to choose from, and at what price, eu-central-1.
// m7i-flex.large is the verified rate in docs/costs.md; the rest are us-east-1
// list prices scaled by the same regional ratio (about 1.2). Only this replay
// reads them.
const SHAPES: readonly PricedShape[] = [
  { instanceType: "m7i-flex.large", memoryMiB: 8 * 1024, vcpu: 2, usdPerHour: 0.11471 },
  { instanceType: "r7i.large", memoryMiB: 16 * 1024, vcpu: 2, usdPerHour: 0.1585 },
  { instanceType: "r7i.xlarge", memoryMiB: 32 * 1024, vcpu: 4, usdPerHour: 0.317 },
  { instanceType: "r7i.2xlarge", memoryMiB: 64 * 1024, vcpu: 8, usdPerHour: 0.634 },
];
const IPV4_PER_HOUR = 0.005;
const GRACE_SECONDS = 10 * 60;
const PROVISION_SECONDS = 4 * 60; // a created host, measured nowhere yet; ADR-0048 estimates four to eight

// Footprints: the catalog's figures (control-plane/catalog.ts). The modded
// Minecraft was measured near 6 GiB on a 4 GiB heap; the limit sits above it.
const FOOTPRINTS: Record<string, Footprint> = {
  modded: { memoryMiB: 7 * 1024, cores: 1 },
  vanilla: { memoryMiB: 3 * 1024, cores: 0.5 },
  factorio: { memoryMiB: 2 * 1024, cores: 0.5 },
  zomboid: { memoryMiB: 8 * 1024, cores: 1 },
};

type Event = { at: number; kind: "start" | "stop"; world: string; game: keyof typeof FOOTPRINTS };
const H = 3600;

function evening(spec: readonly (readonly [string, keyof typeof FOOTPRINTS, number, number])[]): Event[] {
  return spec
    .flatMap(([world, game, from, to]) => [
      { at: Math.round(from * H), kind: "start", world, game } satisfies Event,
      { at: Math.round(to * H), kind: "stop", world, game } satisfies Event,
    ])
    .sort((a, b) => a.at - b.at || (a.kind === "stop" ? -1 : 1));
}

// A fleet's evening: many groups, arrivals spread over the night, a mix of
// games. Deterministic, so two runs compare like for like.
function crowd(count: number, seed: number): Event[] {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 2 ** 32; };
  const games: (keyof typeof FOOTPRINTS)[] = ["factorio", "factorio", "factorio", "factorio", "vanilla", "vanilla", "vanilla", "modded", "modded", "zomboid"];
  const spec: (readonly [string, keyof typeof FOOTPRINTS, number, number])[] = [];
  for (let i = 0; i < count; i += 1) {
    const game = games[Math.floor(next() * games.length)]!;
    const from = 18 + next() * 5;
    spec.push([`${game}-${i}`, game, from, from + 1 + next() * 3]);
  }
  return evening(spec);
}

const SCENARIOS: Record<string, Event[]> = {
  "one modded world, three hours": evening([["techno", "modded", 20, 23]]),
  "modded + factorio + vanilla, overlapping": evening([["techno", "modded", 20, 23], ["factorio", "factorio", 20.5, 22.5], ["vanilla", "vanilla", 21, 23.5]]),
  "three modded worlds, overlapping": evening([["techno", "modded", 20, 23], ["magic", "modded", 20.5, 23.5], ["zomboid", "zomboid", 21, 22]]),
  "stop and restart inside the grace period": evening([["techno", "modded", 20, 21.5], ["techno-again", "modded", 21.6, 23]]),
  "a busy night: six small servers": evening([["f1", "factorio", 19, 23], ["f2", "factorio", 19.5, 22], ["v1", "vanilla", 20, 23], ["v2", "vanilla", 20, 21], ["f3", "factorio", 21, 23], ["v3", "vanilla", 21.5, 23.5]]),
  "a fleet's evening: forty servers for many groups": crowd(40, 42),
  "a fleet's evening: two hundred servers": crowd(200, 7),
};

type Policy = { name: string; reuse: boolean; headroomMiB: number };
const POLICIES: readonly Policy[] = [
  { name: "one per world (ADR-0048)", reuse: false, headroomMiB: 0 },
  { name: "reuse, else launch what fits", reuse: true, headroomMiB: 0 },
  { name: "the same, keeping 8 GiB headroom", reuse: true, headroomMiB: 8 * 1024 },
  { name: "the same, keeping 16 GiB headroom", reuse: true, headroomMiB: 16 * 1024 },
];

// EC2 Fleet `instant`, lowest-price: the cheapest type that meets the minimums.
function fleetAnswer(requirements: LaunchRequirements): PricedShape {
  const fits = SHAPES.filter((shape) => shape.memoryMiB >= requirements.memoryMiB && shape.vcpu >= requirements.vcpu);
  const [cheapest] = [...fits].sort((a, b) => a.usdPerHour - b.usdPerHour);
  if (!cheapest) throw new Error(`no instance type meets ${JSON.stringify(requirements)}`);
  return cheapest;
}

type Sim = { hosts: HostRecord[]; launchedAt: Map<string, number>; terminatedAt: Map<string, number>; shapeOf: Map<string, PricedShape>; log: string[]; warmStarts: number };

function run(events: readonly Event[], policy: Policy): Sim {
  const sim: Sim = { hosts: [], launchedAt: new Map(), terminatedAt: new Map(), shapeOf: new Map(), log: [], warmStarts: 0 };
  const sessions = new Map<string, string>(); // world -> hostId
  let counter = 0;
  const t = (s: number) => `${String(Math.floor(s / H) % 24).padStart(2, "0")}:${String(Math.floor((s % H) / 60)).padStart(2, "0")}`;

  const launch = (requirements: LaunchRequirements, at: number, why: string): string => {
    counter += 1;
    const hostId = `host-${counter}`;
    const shape = fleetAnswer(requirements);
    sim.shapeOf.set(hostId, shape);
    sim.launchedAt.set(hostId, at);
    sim.hosts.push(markReady(newHost(hostId, shape, at), at + PROVISION_SECONDS));
    sim.log.push(`${t(at)}  ${why.padEnd(12)} → launch ≥${requirements.memoryMiB / 1024} GiB, EC2 answers ${shape.instanceType} as ${hostId}`);
    return hostId;
  };

  const keepHeadroom = (now: number) => {
    const needed = headroomLaunch(sim.hosts, policy.headroomMiB);
    if (needed) launch(needed, now, "headroom");
  };

  const settle = (now: number) => {
    sim.hosts = sim.hosts.map((host) => {
      const decision = drainDecision(host, now, GRACE_SECONDS, holdsHeadroom(sim.hosts, host, policy.headroomMiB));
      if (decision === "keep") return host;
      // The drain machine fires at the end of the grace period, not at the next
      // event this replay happens to visit; bill and log it at the real moment.
      const endedAt = host.drainingSinceEpochSeconds! + GRACE_SECONDS;
      const gone = markTerminating(host, endedAt);
      sim.terminatedAt.set(host.hostId, endedAt);
      sim.log.push(`${t(endedAt)}  ${host.hostId} empty for ${GRACE_SECONDS / 60} min → ${decision}`);
      return gone;
    }).filter((host) => host.state !== "terminating");
  };

  for (const event of events) {
    settle(event.at);
    if (event.kind === "start") {
      const footprint = FOOTPRINTS[event.game]!;
      const candidates = policy.reuse ? sim.hosts : [];
      const placement = place(candidates, footprint, event.world);
      let hostId: string;
      if (placement.kind === "launch") {
        hostId = launch(placement.requirements, event.at, event.world);
      } else {
        hostId = placement.hostId;
        sim.warmStarts += 1;
        sim.log.push(`${t(event.at)}  ${event.world.padEnd(12)} → reuse ${hostId} (${sim.shapeOf.get(hostId)!.instanceType})`);
      }
      sim.hosts = sim.hosts.map((host) => host.hostId === hostId
        ? reserve(host, { sessionId: `s-${event.world}`, worldId: event.world, footprint, policy: "cold" }, event.at)
        : host);
      sessions.set(event.world, hostId);
      keepHeadroom(event.at);
    } else {
      const hostId = sessions.get(event.world)!;
      sim.hosts = sim.hosts.map((host) => host.hostId === hostId ? release(host, `s-${event.world}`, event.at) : host);
      sim.log.push(`${t(event.at)}  ${event.world.padEnd(12)} ← stop on ${hostId}`);
    }
  }
  const last = events.at(-1)!.at;
  settle(last + GRACE_SECONDS);
  return sim;
}

function cost(sim: Sim, sessions: number): { hostHours: number; usd: number; hosts: number; warmShare: number } {
  let usd = 0;
  let hostHours = 0;
  for (const [hostId, from] of sim.launchedAt) {
    const to = sim.terminatedAt.get(hostId)!;
    const hours = (to - from) / H;
    hostHours += hours;
    usd += hours * (sim.shapeOf.get(hostId)!.usdPerHour + IPV4_PER_HOUR);
  }
  // A session placed on a running host skips provisioning and the image pull:
  // the share of starts that were warm is what headroom buys before it buys money.
  const warmShare = sessions === 0 ? 0 : sim.warmStarts / sessions;
  return { hostHours, usd, hosts: sim.launchedAt.size, warmShare };
}

const verbose = process.argv.includes("--verbose");
for (const [name, events] of Object.entries(SCENARIOS)) {
  console.log(`\n== ${name}`);
  const sessions = events.filter((event) => event.kind === "start").length;
  console.log(`   ${"policy".padEnd(38)} ${"hosts".padStart(5)} ${"host-hours".padStart(10)} ${"USD".padStart(7)} ${"warm starts".padStart(11)}`);
  for (const policy of POLICIES) {
    const sim = run(events, policy);
    const { hosts, hostHours, usd, warmShare } = cost(sim, sessions);
    const warmPercentage = `${Math.round(warmShare * 100)}%`;
    console.log(`   ${policy.name.padEnd(38)} ${String(hosts).padStart(5)} ${hostHours.toFixed(2).padStart(10)} ${usd.toFixed(2).padStart(7)} ${warmPercentage.padStart(11)}`);
    if (verbose) for (const line of sim.log) console.log(`      ${line}`);
  }
}
console.log("\nRates are estimates except m7i-flex.large; see docs/costs.md. Run with --verbose for the fleet timeline.");
