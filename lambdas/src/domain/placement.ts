// Where a session runs: on a host that already has room for it, or on a host
// launched for it (ADR-0054). Pure transitions over a host record, applied by
// a store with a conditional write on `version` — the same discipline as
// lifecycle.ts, so two starts racing for the last gigabyte cannot both win.

export type Footprint = Readonly<{
  /**
   * A hard limit for the container's cgroup, so a neighbour's leak cannot reach
   * this session. It is the heap plus the off-heap margin, never the heap
   * alone: a modded Minecraft with a 4 GiB heap was measured near 6 GiB.
   */
  memoryMiB: number;
  /**
   * A weight, not a limit: how many cores' worth this session is expected to
   * want. It bounds how many sessions share a host's cores; it does not pin
   * them, because a tick loop that runs on one core gains nothing from a pin.
   */
  cores: number;
}>;

/**
 * What a host turned out to be. EC2 chooses the type at launch from the
 * requirements below, by price at that moment; the shape is read back from the
 * instance and recorded, never picked from a list in this code.
 */
export type HostShape = Readonly<{
  instanceType: string;
  memoryMiB: number;
  vcpu: number;
}>;

/**
 * What a launch asks EC2 for: minimums, and nothing about types or prices. An
 * EC2 Fleet of type `instant` with these as `InstanceRequirements` and the
 * `lowest-price` strategy returns the cheapest instance that meets them today;
 * the same request with a Spot target capacity is ADR-0027.
 */
export type LaunchRequirements = Readonly<{
  memoryMiB: number;
  vcpu: number;
}>;

// The OS, Docker, the overlay client and the per-host observability stack.
export const SYSTEM_RESERVE_MIB = 1024;
export const SYSTEM_RESERVE_CORES = 0.5;
// Slots number the ports on a host, so the slot index is the port allocator and
// nothing else is. Slot zero keeps the game's own ports, byte-identical to a
// host with one session; every other slot owns a window in one host-wide range,
// so sessions cannot collide whatever games they run. Memory fills a host long
// before the range does; the cap is the range's, not the fleet's.
export const SLOT_PORT_RANGE_START = 30000;
export const SLOT_PORT_WINDOW = 10;
export const MAX_SLOTS = 256;

export type GamePorts = Readonly<{ game: number; rcon: number }>;

export type SessionPolicy = "cold" | "warm";
export type HostState = "provisioning" | "ready" | "draining" | "stopped" | "terminating";
/**
 * `configured` is the host Terraform declares: its volume, its overlay
 * identity and the legacy worlds live on it, so a drain stops it and never
 * terminates it. `launched` is a host the control plane created for a session
 * from a launch template; it holds nothing that outlives its sessions.
 */
export type HostProvenance = "configured" | "launched";

export type Reservation = Readonly<{
  sessionId: string;
  worldId: string;
  slot: number;
  footprint: Footprint;
  policy: SessionPolicy;
}>;

export type HostRecord = Readonly<{
  schemaVersion: 1;
  hostId: string;
  shape: HostShape;
  provenance: HostProvenance;
  state: HostState;
  reservations: readonly Reservation[];
  drainingSinceEpochSeconds: number | null;
  /**
   * A stopped `warm` host keeps one world's data on its volumes. It is a
   * placement candidate for that world alone; to every other world it does not
   * exist, because it holds nothing they can use and its shape was not chosen
   * for them.
   */
  keptWorldId: string | null;
  version: number;
  updatedAtEpochSeconds: number;
}>;

export type Placement =
  | Readonly<{ kind: "reuse"; hostId: string }>
  | Readonly<{ kind: "launch"; requirements: LaunchRequirements }>;

export type DrainDecision = "keep" | "stop" | "terminate";

export class PlacementConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlacementConflict";
  }
}

function requireId(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function requireEpoch(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}

function requireFootprint(footprint: Footprint): void {
  if (!Number.isSafeInteger(footprint.memoryMiB) || footprint.memoryMiB <= 0) throw new Error("footprint.memoryMiB must be a positive integer");
  if (footprint.cores <= 0 || !Number.isFinite(footprint.cores)) throw new Error("footprint.cores must be positive");
}

export function capacity(shape: HostShape): Footprint {
  return {
    memoryMiB: Math.max(0, shape.memoryMiB - SYSTEM_RESERVE_MIB),
    cores: Math.max(0, shape.vcpu - SYSTEM_RESERVE_CORES),
  };
}

export function remaining(host: HostRecord): Footprint {
  const total = capacity(host.shape);
  const used = host.reservations.reduce(
    (sum, reservation) => ({ memoryMiB: sum.memoryMiB + reservation.footprint.memoryMiB, cores: sum.cores + reservation.footprint.cores }),
    { memoryMiB: 0, cores: 0 },
  );
  return { memoryMiB: total.memoryMiB - used.memoryMiB, cores: total.cores - used.cores };
}

function fitsWithin(room: Footprint, footprint: Footprint): boolean {
  return footprint.memoryMiB <= room.memoryMiB && footprint.cores <= room.cores + 1e-9;
}

export function shapeFits(shape: HostShape, footprint: Footprint): boolean {
  return fitsWithin(capacity(shape), footprint);
}

/**
 * The smallest host that holds the footprint beside the system: what a launch
 * asks for, so an evening with one world costs what it costs today and packing
 * only ever adds a tenant to a host that already exists. Cores round up to
 * whole vCPUs because that is the unit EC2 sells.
 */
export function requirementsFor(footprint: Footprint): LaunchRequirements {
  requireFootprint(footprint);
  return {
    memoryMiB: footprint.memoryMiB + SYSTEM_RESERVE_MIB,
    vcpu: Math.ceil(footprint.cores + SYSTEM_RESERVE_CORES),
  };
}

/** Free memory across the hosts a session could land on right now. */
export function fleetRoomMiB(hosts: readonly HostRecord[]): number {
  return hosts
    .filter((host) => host.state === "ready" || host.state === "draining")
    .reduce((sum, host) => sum + Math.max(0, remaining(host).memoryMiB), 0);
}

/**
 * Headroom is the paid choice for a warmer fleet: while anything is running,
 * keep at least `targetMiB` free somewhere, so the next start lands on a host
 * already up instead of waiting for one. Nothing is kept when nothing runs,
 * which is the rule this whole system is built on. Returns what to launch when
 * the fleet is short, or null.
 */
export function headroomLaunch(hosts: readonly HostRecord[], targetMiB: number): LaunchRequirements | null {
  if (!Number.isSafeInteger(targetMiB) || targetMiB < 0) throw new Error("targetMiB must be a non-negative integer");
  const active = hosts.some((host) => host.reservations.length > 0);
  if (!active || targetMiB === 0 || fleetRoomMiB(hosts) >= targetMiB) return null;
  return { memoryMiB: targetMiB + SYSTEM_RESERVE_MIB, vcpu: 1 };
}

/**
 * Whether an empty host is the fleet's headroom: without it the running
 * sessions would have less than `targetMiB` free beside them.
 */
export function holdsHeadroom(hosts: readonly HostRecord[], host: HostRecord, targetMiB: number): boolean {
  if (targetMiB === 0 || host.reservations.length > 0) return false;
  const others = hosts.filter((other) => other.hostId !== host.hostId);
  return others.some((other) => other.reservations.length > 0) && fleetRoomMiB(others) < targetMiB;
}

function slotFree(host: HostRecord, slot: number | undefined): boolean {
  return slot === undefined || !host.reservations.some((reservation) => reservation.slot === slot);
}

/**
 * Whether this host can take the footprint for this world right now. A pinned
 * `slot` — zero, for a public world or a game that names its own ports — must
 * be free as well.
 */
export function accepts(host: HostRecord, footprint: Footprint, worldId: string, slot?: number): boolean {
  if (host.reservations.length >= MAX_SLOTS) return false;
  if (!slotFree(host, slot)) return false;
  if (host.state === "stopped") return host.keptWorldId === worldId && fitsWithin(remaining(host), footprint);
  if (host.state !== "ready" && host.state !== "draining") return false;
  return fitsWithin(remaining(host), footprint);
}

/**
 * Every host that could take the session, best fit first: a stopped host that
 * keeps this world, then the live hosts by least memory left after placing.
 * A start that loses the conditional write on the first candidate takes the
 * next one rather than reading the fleet again, which is what keeps many
 * simultaneous starts from queueing on one tight host.
 */
export function placementCandidates(hosts: readonly HostRecord[], footprint: Footprint, worldId: string, slot?: number): readonly HostRecord[] {
  requireFootprint(footprint);
  requireId("worldId", worldId);
  const candidates = hosts.filter((host) => accepts(host, footprint, worldId, slot));
  const kept = candidates.filter((host) => host.state === "stopped");
  const live = candidates
    .filter((host) => host.state !== "stopped")
    .sort((a, b) => {
      const leftA = remaining(a).memoryMiB - footprint.memoryMiB;
      const leftB = remaining(b).memoryMiB - footprint.memoryMiB;
      return leftA - leftB || a.hostId.localeCompare(b.hostId);
    });
  return [...kept, ...live];
}

/**
 * Best fit: the host that would have the least memory left, so tenants gather
 * on few hosts and the rest drain. When none has room, a launch for exactly
 * what the footprint needs; which instance that becomes, and at what price, is
 * EC2's answer at launch time. One pass over the hosts, at any fleet size.
 */
export function place(hosts: readonly HostRecord[], footprint: Footprint, worldId: string, slot?: number): Placement {
  const [best] = placementCandidates(hosts, footprint, worldId, slot);
  if (best) return { kind: "reuse", hostId: best.hostId };
  return { kind: "launch", requirements: requirementsFor(footprint) };
}

export function newHost(hostId: string, shape: HostShape, nowEpochSeconds: number, provenance: HostProvenance = "configured"): HostRecord {
  requireId("hostId", hostId);
  requireEpoch("nowEpochSeconds", nowEpochSeconds);
  return {
    schemaVersion: 1,
    hostId,
    shape,
    provenance,
    state: "provisioning",
    reservations: [],
    drainingSinceEpochSeconds: null,
    keptWorldId: null,
    version: 0,
    updatedAtEpochSeconds: nowEpochSeconds,
  };
}

function bump(host: HostRecord, changes: Partial<HostRecord>, nowEpochSeconds: number): HostRecord {
  requireEpoch("nowEpochSeconds", nowEpochSeconds);
  return { ...host, ...changes, version: host.version + 1, updatedAtEpochSeconds: nowEpochSeconds };
}

/**
 * A host that answers is up; a host that is up with nobody on it is on the
 * clock from that moment. So an empty host becomes `draining`, not `ready`:
 * the first reservation makes it ready, and a host launched for headroom that
 * nobody reaches is terminated after one grace period like any other.
 */
export function markReady(host: HostRecord, nowEpochSeconds: number): HostRecord {
  if (host.state !== "provisioning" && host.state !== "stopped") {
    throw new PlacementConflict(`host ${host.hostId} is ${host.state}, not provisioning or stopped`);
  }
  if (host.reservations.length === 0) return bump(host, { state: "draining", drainingSinceEpochSeconds: nowEpochSeconds }, nowEpochSeconds);
  return bump(host, { state: "ready", drainingSinceEpochSeconds: null }, nowEpochSeconds);
}

export function reserve(
  host: HostRecord,
  request: Readonly<{ sessionId: string; worldId: string; footprint: Footprint; policy: SessionPolicy; slot?: number }>,
  nowEpochSeconds: number,
): HostRecord {
  requireId("sessionId", request.sessionId);
  requireId("worldId", request.worldId);
  requireFootprint(request.footprint);
  if (host.reservations.some((reservation) => reservation.sessionId === request.sessionId)) {
    throw new PlacementConflict(`session ${request.sessionId} is already placed on ${host.hostId}`);
  }
  if (!accepts(host, request.footprint, request.worldId, request.slot)) {
    const slotDescription = request.slot === undefined ? "" : ` on slot ${request.slot}`;
    throw new PlacementConflict(`host ${host.hostId} has no room for ${request.worldId}${slotDescription}`);
  }
  const taken = new Set(host.reservations.map((reservation) => reservation.slot));
  let slot = request.slot ?? 0;
  if (request.slot === undefined) while (taken.has(slot)) slot += 1;
  const reservation: Reservation = { sessionId: request.sessionId, worldId: request.worldId, slot, footprint: request.footprint, policy: request.policy };
  // A reservation on a draining host cancels the drain: the grace period exists
  // exactly so that a stop followed by a start reuses the machine.
  return bump(host, {
    state: "ready",
    reservations: [...host.reservations, reservation],
    drainingSinceEpochSeconds: null,
    keptWorldId: null,
  }, nowEpochSeconds);
}

export function release(host: HostRecord, sessionId: string, nowEpochSeconds: number): HostRecord {
  requireId("sessionId", sessionId);
  const leaving = host.reservations.find((reservation) => reservation.sessionId === sessionId);
  if (!leaving) throw new PlacementConflict(`session ${sessionId} is not placed on ${host.hostId}`);
  const reservations = host.reservations.filter((reservation) => reservation.sessionId !== sessionId);
  if (reservations.length > 0) return bump(host, { reservations }, nowEpochSeconds);
  return bump(host, {
    state: "draining",
    reservations,
    drainingSinceEpochSeconds: nowEpochSeconds,
    keptWorldId: leaving.policy === "warm" ? leaving.worldId : null,
  }, nowEpochSeconds);
}

/**
 * What to do with an empty host. `keep` while a session may still come back
 * inside the grace period, or while the host is the fleet's headroom; after
 * that, `stop` for the configured host and for a host whose last tenant was a
 * warm world, `terminate` for a launched host nobody kept. The caller re-reads
 * the record and applies the transition conditionally, because a start may
 * have landed meanwhile.
 */
export function drainDecision(host: HostRecord, nowEpochSeconds: number, gracePeriodSeconds: number, holdForHeadroom = false): DrainDecision {
  requireEpoch("nowEpochSeconds", nowEpochSeconds);
  requireEpoch("gracePeriodSeconds", gracePeriodSeconds);
  if (holdForHeadroom) return "keep";
  if (host.state !== "draining" || host.reservations.length > 0 || host.drainingSinceEpochSeconds === null) return "keep";
  if (nowEpochSeconds < host.drainingSinceEpochSeconds + gracePeriodSeconds) return "keep";
  if (host.keptWorldId !== null) return "stop";
  // The configured host is Terraform's, and everything that outlives a session
  // lives on it. It stops, as it always has; only a launched host is let go.
  return host.provenance === "configured" ? "stop" : "terminate";
}

export function markStopped(host: HostRecord, nowEpochSeconds: number): HostRecord {
  if (host.state !== "draining" || host.reservations.length > 0) throw new PlacementConflict(`host ${host.hostId} is not an empty draining host`);
  return bump(host, { state: "stopped", drainingSinceEpochSeconds: null }, nowEpochSeconds);
}

export function markTerminating(host: HostRecord, nowEpochSeconds: number): HostRecord {
  if ((host.state !== "draining" && host.state !== "stopped") || host.reservations.length > 0) {
    throw new PlacementConflict(`host ${host.hostId} is not an empty draining or stopped host`);
  }
  return bump(host, { state: "terminating", drainingSinceEpochSeconds: null, keptWorldId: null }, nowEpochSeconds);
}

/**
 * The ports a session binds on its host. Slot zero is the game's own pair, so
 * the adapters keep working unchanged on a host with one session; any other
 * slot takes the first two ports of its window in the host-wide range.
 */
export function portsForSlot(gameDefaults: GamePorts, slot: number): GamePorts {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= MAX_SLOTS) throw new Error(`slot must be 0..${MAX_SLOTS - 1}`);
  if (slot === 0) return gameDefaults;
  const window = SLOT_PORT_RANGE_START + slot * SLOT_PORT_WINDOW;
  return { game: window, rcon: window + 1 };
}
