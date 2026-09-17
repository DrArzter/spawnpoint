// The placement side of the coordinator (ADR-0054): one record per host,
// beside the lifecycle records, applied with a conditional write on its
// revision. Two starts that race for the last gigabyte both compute a fit;
// one write lands; the other takes its next candidate.

import { footprintForWorld, gameFootprints } from "../control-plane/catalog.ts";
import {
  PlacementConflict,
  drainDecision,
  holdsHeadroom,
  markReady,
  markStopped,
  markTerminating,
  newHost,
  placementCandidates,
  release,
  requirementsFor,
  reserve,
  type DrainDecision,
  type Footprint,
  type HostRecord,
  type HostShape,
  type LaunchRequirements,
  type SessionPolicy,
} from "../domain/placement.ts";

export type VersionedHost = Readonly<{
  revision: number;
  record: HostRecord;
}>;

export interface PlacementStore {
  readHost(hostId: string): Promise<VersionedHost | null>;
  listHosts(): Promise<readonly VersionedHost[]>;
  createHost(record: HostRecord): Promise<boolean>;
  compareAndSetHost(hostId: string, expectedRevision: number, record: HostRecord): Promise<boolean>;
}

type SessionRequest = Readonly<{
  sessionId: string;
  worldId: string;
  /** The lifecycle's server id, which is the game: the footprint's last resort. */
  serverId?: string;
  footprint?: Footprint;
  policy?: SessionPolicy;
}>;

export type PlacementInput =
  | Readonly<{ action: "registerHost"; hostId: string; shape: HostShape; ready?: boolean }>
  | Readonly<{ action: "markHostReady"; hostId: string }>
  | Readonly<{ action: "getHost"; hostId: string }>
  | Readonly<{ action: "listHosts" }>
  | (Readonly<{ action: "placeSession" }> & SessionRequest)
  | (Readonly<{ action: "reserveOnHost"; hostId: string }> & SessionRequest)
  | Readonly<{ action: "releasePlacement"; hostId: string; sessionId: string }>
  | Readonly<{ action: "decideDrain"; hostId: string; gracePeriodSeconds: number; headroomMiB?: number }>
  | Readonly<{ action: "concludeDrain"; hostId: string; outcome: "stop" | "terminate" }>;

export type PlacementOutcome =
  | Readonly<{ kind: "reuse"; hostId: string; slot: number }>
  | Readonly<{ kind: "launch"; requirements: LaunchRequirements }>;

export type PlacementOutput = Readonly<{
  host?: VersionedHost;
  hosts?: readonly VersionedHost[];
  placement?: PlacementOutcome;
  released?: boolean;
  drain?: DrainDecision;
}>;

const PLACEMENT_ACTIONS: ReadonlySet<string> = new Set([
  "registerHost", "markHostReady", "getHost", "listHosts", "placeSession", "reserveOnHost", "releasePlacement", "decideDrain", "concludeDrain",
]);

export function isPlacementInput(input: Readonly<{ action: string }>): input is PlacementInput {
  return PLACEMENT_ACTIONS.has(input.action);
}

const MAX_CAS_ATTEMPTS = 5;

function requireId(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value;
}

// The footprint a session is placed with: what the caller says, else the
// world's catalog entry, else its game's default. A world nobody can size is
// refused here, before a host is chosen for it.
export function resolveFootprint(request: SessionRequest): Footprint {
  if (request.footprint) return request.footprint;
  try {
    return footprintForWorld(request.worldId);
  } catch {
    const byGame = request.serverId === undefined ? undefined : gameFootprints[request.serverId];
    if (byGame) return byGame;
    throw new PlacementConflict(`no footprint for world ${request.worldId}`);
  }
}

export function createPlacementCoordinator(
  store: PlacementStore,
  nowEpochSeconds: () => number = () => Math.floor(Date.now() / 1_000),
): (input: PlacementInput) => Promise<PlacementOutput> {
  async function loadRequired(hostId: string): Promise<VersionedHost> {
    const current = await store.readHost(hostId);
    if (current === null) throw new PlacementConflict(`host ${hostId} is not registered`);
    return current;
  }

  async function mutate(hostId: string, mutation: (record: HostRecord, now: number) => HostRecord): Promise<VersionedHost> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await loadRequired(hostId);
      const record = mutation(current.record, nowEpochSeconds());
      if (record === current.record) return current;
      if (await store.compareAndSetHost(hostId, current.revision, record)) {
        return { revision: current.revision + 1, record };
      }
    }
    throw new PlacementConflict(`host ${hostId} changed repeatedly during conditional write`);
  }

  function existingReservation(hosts: readonly VersionedHost[], sessionId: string): PlacementOutcome | null {
    for (const host of hosts) {
      const held = host.record.reservations.find((reservation) => reservation.sessionId === sessionId);
      if (held) return { kind: "reuse", hostId: host.record.hostId, slot: held.slot };
    }
    return null;
  }

  // One conditional write per candidate; a lost write moves to the next host
  // rather than back to the fleet. Returns null when no candidate took it.
  async function reserveOnFirst(candidates: readonly VersionedHost[], request: SessionRequest, footprint: Footprint): Promise<PlacementOutcome | null> {
    for (const candidate of candidates) {
      const record = reserve(candidate.record, { sessionId: request.sessionId, worldId: request.worldId, footprint, policy: request.policy ?? "cold" }, nowEpochSeconds());
      if (await store.compareAndSetHost(candidate.record.hostId, candidate.revision, record)) {
        const held = record.reservations.find((reservation) => reservation.sessionId === request.sessionId)!;
        return { kind: "reuse", hostId: record.hostId, slot: held.slot };
      }
    }
    return null;
  }

  return async (input: PlacementInput): Promise<PlacementOutput> => {
    switch (input.action) {
      case "registerHost": {
        const hostId = requireId("hostId", input.hostId);
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = await store.readHost(hostId);
          if (current !== null) {
            return { host: input.ready && current.record.state === "provisioning" ? await mutate(hostId, (record, now) => markReady(record, now)) : current };
          }
          let record = newHost(hostId, input.shape, nowEpochSeconds());
          if (input.ready) record = markReady(record, nowEpochSeconds());
          if (await store.createHost(record)) return { host: { revision: 1, record } };
        }
        throw new PlacementConflict(`host ${hostId} registration did not converge`);
      }
      case "markHostReady":
        return { host: await mutate(requireId("hostId", input.hostId), (record, now) => markReady(record, now)) };
      case "getHost":
        return { host: await loadRequired(requireId("hostId", input.hostId)) };
      case "listHosts":
        return { hosts: await store.listHosts() };
      case "placeSession": {
        requireId("sessionId", input.sessionId);
        requireId("worldId", input.worldId);
        const footprint = resolveFootprint(input);
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const hosts = await store.listHosts();
          const already = existingReservation(hosts, input.sessionId);
          if (already) return { placement: already };
          const ranked = placementCandidates(hosts.map((host) => host.record), footprint, input.worldId);
          const candidates = ranked.map((record) => hosts.find((host) => host.record.hostId === record.hostId)!);
          if (candidates.length === 0) return { placement: { kind: "launch", requirements: requirementsFor(footprint) } };
          const taken = await reserveOnFirst(candidates, input, footprint);
          if (taken) return { placement: taken };
        }
        throw new PlacementConflict("the fleet changed repeatedly while placing");
      }
      case "reserveOnHost": {
        const hostId = requireId("hostId", input.hostId);
        requireId("sessionId", input.sessionId);
        requireId("worldId", input.worldId);
        const footprint = resolveFootprint(input);
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = await loadRequired(hostId);
          const already = existingReservation([current], input.sessionId);
          if (already) return { host: current, placement: already };
          const taken = await reserveOnFirst([current], input, footprint);
          if (taken) return { host: await loadRequired(hostId), placement: taken };
        }
        throw new PlacementConflict(`host ${hostId} changed repeatedly while reserving`);
      }
      case "releasePlacement": {
        // Tolerant on purpose: a session that predates placement, or a host
        // record that never existed, is not a reason to fail a verified stop.
        const hostId = requireId("hostId", input.hostId);
        const sessionId = requireId("sessionId", input.sessionId);
        const current = await store.readHost(hostId);
        if (current === null) return { released: false };
        if (!current.record.reservations.some((reservation) => reservation.sessionId === sessionId)) return { released: false, host: current };
        const host = await mutate(hostId, (record, now) => release(record, sessionId, now));
        return { released: true, host };
      }
      case "decideDrain": {
        const hostId = requireId("hostId", input.hostId);
        const hosts = await store.listHosts();
        const current = hosts.find((host) => host.record.hostId === hostId) ?? await loadRequired(hostId);
        const hold = holdsHeadroom(hosts.map((host) => host.record), current.record, input.headroomMiB ?? 0);
        return { host: current, drain: drainDecision(current.record, nowEpochSeconds(), input.gracePeriodSeconds, hold) };
      }
      case "concludeDrain": {
        const hostId = requireId("hostId", input.hostId);
        const host = await mutate(hostId, (record, now) => input.outcome === "stop" ? markStopped(record, now) : markTerminating(record, now));
        return { host };
      }
      default: {
        const unreachable: never = input;
        throw new Error(`unsupported placement action: ${JSON.stringify(unreachable)}`);
      }
    }
  };
}
