// The placement side of the coordinator (ADR-0054): one record per host,
// beside the lifecycle records, applied with a conditional write on its
// revision. Two starts that race for the last gigabyte both compute a fit;
// one write lands; the other takes its next candidate.

import { footprintForWorld, gameFootprints, worldHostBinding, worldNeedsSlotZero } from "../control-plane/catalog.ts";
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
  type HostProvenance,
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
  /** Restrict candidates without changing the placement algorithm. */
  eligibleProvenance?: HostProvenance;
}>;

export type PlacementInput =
  | Readonly<{ action: "registerHost"; hostId: string; shape: HostShape; ready?: boolean; provenance?: HostProvenance }>
  | Readonly<{ action: "markHostReady"; hostId: string }>
  | Readonly<{ action: "getHost"; hostId: string }>
  | Readonly<{ action: "listHosts" }>
  | (Readonly<{ action: "placeSession" }> & SessionRequest)
  | (Readonly<{ action: "reserveOnHost"; hostId: string }> & SessionRequest)
  | Readonly<{ action: "findPlacement"; sessionId: string }>
  | Readonly<{ action: "releasePlacement"; hostId?: string; sessionId: string }>
  | Readonly<{ action: "decideDrain"; hostId: string; gracePeriodSeconds: number; headroomMiB?: number }>
  | Readonly<{ action: "concludeDrain"; hostId: string; outcome: "stop" | "terminate" }>;

export type PlacementOutcome =
  | Readonly<{ kind: "reuse"; hostId: string; slot: number }>
  | Readonly<{ kind: "launch"; requirements: LaunchRequirements }>
  // A world whose save lives on the configured host's volume cannot be placed
  // anywhere else, and no launch can help it.
  | Readonly<{ kind: "refused"; reason: "bound_to_configured_host" }>;

export type PlacementOutput = Readonly<{
  /** `null` is an answer: the host in question does not exist. */
  host?: VersionedHost | null;
  hosts?: readonly VersionedHost[];
  /** `null` is an answer: the session is placed nowhere. */
  placement?: PlacementOutcome | null;
  released?: boolean;
  drain?: DrainDecision;
}>;

const PLACEMENT_ACTIONS: ReadonlySet<string> = new Set([
  "registerHost", "markHostReady", "getHost", "listHosts", "placeSession", "reserveOnHost", "findPlacement", "releasePlacement", "decideDrain", "concludeDrain",
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

type CoordinatorContext = Readonly<{
  store: PlacementStore;
  nowEpochSeconds: () => number;
}>;

async function loadRequired(context: CoordinatorContext, hostId: string): Promise<VersionedHost> {
  const current = await context.store.readHost(hostId);
  if (current === null) throw new PlacementConflict(`host ${hostId} is not registered`);
  return current;
}

async function mutateHost(
  context: CoordinatorContext,
  hostId: string,
  mutation: (record: HostRecord, now: number) => HostRecord,
): Promise<VersionedHost> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await loadRequired(context, hostId);
    const record = mutation(current.record, context.nowEpochSeconds());
    if (record === current.record) return current;
    if (await context.store.compareAndSetHost(hostId, current.revision, record)) {
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

// A public world and a game that names its own ports take slot zero only.
function pinnedSlot(request: SessionRequest): number | undefined {
  return worldNeedsSlotZero(request.worldId, request.serverId) ? 0 : undefined;
}

// One conditional write per candidate; a lost write moves to the next host
// rather than back to the fleet. Returns null when no candidate took it.
async function reserveOnFirst(
  context: CoordinatorContext,
  candidates: readonly VersionedHost[],
  request: SessionRequest,
  footprint: Footprint,
): Promise<PlacementOutcome | null> {
  const slot = pinnedSlot(request);
  for (const candidate of candidates) {
    const record = reserve(candidate.record, {
      sessionId: request.sessionId,
      worldId: request.worldId,
      footprint,
      policy: request.policy ?? "cold",
      ...(slot === undefined ? {} : { slot }),
    }, context.nowEpochSeconds());
    if (await context.store.compareAndSetHost(candidate.record.hostId, candidate.revision, record)) {
      const held = record.reservations.find((reservation) => reservation.sessionId === request.sessionId);
      if (held === undefined) throw new PlacementConflict(`session ${request.sessionId} was not reserved`);
      return { kind: "reuse", hostId: record.hostId, slot: held.slot };
    }
  }
  return null;
}

async function registerHost(
  context: CoordinatorContext,
  input: Extract<PlacementInput, { action: "registerHost" }>,
): Promise<PlacementOutput> {
  const hostId = requireId("hostId", input.hostId);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await context.store.readHost(hostId);
    if (current !== null) {
      const host = input.ready && current.record.state === "provisioning"
        ? await mutateHost(context, hostId, (record, now) => markReady(record, now))
        : current;
      return { host };
    }
    let record = newHost(hostId, input.shape, context.nowEpochSeconds(), input.provenance ?? "configured");
    if (input.ready) record = markReady(record, context.nowEpochSeconds());
    if (await context.store.createHost(record)) return { host: { revision: 1, record } };
  }
  throw new PlacementConflict(`host ${hostId} registration did not converge`);
}

function rankedCandidates(
  hosts: readonly VersionedHost[],
  request: SessionRequest,
  footprint: Footprint,
): readonly VersionedHost[] {
  const binding = worldHostBinding(request.worldId);
  const eligible = hosts.filter((host) => {
    if (binding === "configured" && host.record.provenance !== "configured") return false;
    return request.eligibleProvenance === undefined || host.record.provenance === request.eligibleProvenance;
  });
  const ranked = placementCandidates(
    eligible.map((host) => host.record),
    footprint,
    request.worldId,
    pinnedSlot(request),
  );
  return ranked.map((record) => {
    const candidate = eligible.find((host) => host.record.hostId === record.hostId);
    if (candidate === undefined) throw new PlacementConflict(`ranked host ${record.hostId} disappeared`);
    return candidate;
  });
}

function noCandidateOutcome(request: SessionRequest, footprint: Footprint): PlacementOutcome {
  return worldHostBinding(request.worldId) === "configured"
    ? { kind: "refused", reason: "bound_to_configured_host" }
    : { kind: "launch", requirements: requirementsFor(footprint) };
}

async function placeSession(context: CoordinatorContext, request: SessionRequest): Promise<PlacementOutput> {
  requireId("sessionId", request.sessionId);
  requireId("worldId", request.worldId);
  const footprint = resolveFootprint(request);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const hosts = await context.store.listHosts();
    const already = existingReservation(hosts, request.sessionId);
    if (already) return { placement: already };
    const candidates = rankedCandidates(hosts, request, footprint);
    if (candidates.length === 0) return { placement: noCandidateOutcome(request, footprint) };
    const taken = await reserveOnFirst(context, candidates, request, footprint);
    if (taken) return { placement: taken };
  }
  throw new PlacementConflict("the fleet changed repeatedly while placing");
}

async function reserveOnHost(
  context: CoordinatorContext,
  input: Extract<PlacementInput, { action: "reserveOnHost" }>,
): Promise<PlacementOutput> {
  const hostId = requireId("hostId", input.hostId);
  requireId("sessionId", input.sessionId);
  requireId("worldId", input.worldId);
  const footprint = resolveFootprint(input);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await loadRequired(context, hostId);
    const already = existingReservation([current], input.sessionId);
    if (already) return { host: current, placement: already };
    const taken = await reserveOnFirst(context, [current], input, footprint);
    if (taken) return { host: await loadRequired(context, hostId), placement: taken };
  }
  throw new PlacementConflict(`host ${hostId} changed repeatedly while reserving`);
}

async function releasePlacement(
  context: CoordinatorContext,
  input: Extract<PlacementInput, { action: "releasePlacement" }>,
): Promise<PlacementOutput> {
  const sessionId = requireId("sessionId", input.sessionId);
  const found = input.hostId === undefined
    ? existingReservation(await context.store.listHosts(), sessionId)
    : null;
  const hostId = input.hostId ?? (found?.kind === "reuse" ? found.hostId : undefined);
  if (hostId === undefined) return { released: false, host: null };
  const current = await context.store.readHost(hostId);
  if (current === null) return { released: false, host: null };
  const holdsSession = current.record.reservations.some((reservation) => reservation.sessionId === sessionId);
  if (!holdsSession) return { released: false, host: current };
  const host = await mutateHost(context, hostId, (record, now) => release(record, sessionId, now));
  return { released: true, host };
}

async function decideHostDrain(
  context: CoordinatorContext,
  input: Extract<PlacementInput, { action: "decideDrain" }>,
): Promise<PlacementOutput> {
  const hostId = requireId("hostId", input.hostId);
  const hosts = await context.store.listHosts();
  const current = hosts.find((host) => host.record.hostId === hostId)
    ?? await loadRequired(context, hostId);
  const hold = holdsHeadroom(
    hosts.map((host) => host.record),
    current.record,
    input.headroomMiB ?? 0,
  );
  return {
    host: current,
    drain: drainDecision(current.record, context.nowEpochSeconds(), input.gracePeriodSeconds, hold),
  };
}

async function coordinate(context: CoordinatorContext, input: PlacementInput): Promise<PlacementOutput> {
  switch (input.action) {
    case "registerHost": return registerHost(context, input);
    case "markHostReady": return { host: await mutateHost(context, requireId("hostId", input.hostId), (record, now) => markReady(record, now)) };
    case "getHost": return { host: await loadRequired(context, requireId("hostId", input.hostId)) };
    case "listHosts": return { hosts: await context.store.listHosts() };
    case "placeSession": return placeSession(context, input);
    case "reserveOnHost": return reserveOnHost(context, input);
    case "findPlacement": return { placement: existingReservation(await context.store.listHosts(), requireId("sessionId", input.sessionId)) };
    case "releasePlacement": return releasePlacement(context, input);
    case "decideDrain": return decideHostDrain(context, input);
    case "concludeDrain": {
      const mutation = input.outcome === "stop" ? markStopped : markTerminating;
      return { host: await mutateHost(context, requireId("hostId", input.hostId), mutation) };
    }
  }
  const unreachable: never = input;
  throw new Error(`unsupported placement action: ${JSON.stringify(unreachable)}`);
}

export function createPlacementCoordinator(
  store: PlacementStore,
  nowEpochSeconds: () => number = () => Math.floor(Date.now() / 1_000),
): (input: PlacementInput) => Promise<PlacementOutput> {
  const context = { store, nowEpochSeconds };
  return (input) => coordinate(context, input);
}
