import type { AccessCandidate, AccessIdentity, AppearancePreference, BackupEntry, BackupInventory, InvitationRecipient, InvitationSummary, SubscriptionState } from "../auth";
import { identityDeletionRefusal, type ConsoleEntry, type FileLink, type DiffClasses, type DiffMod, type DiffValue, type HostMetrics, type MetricRange, type ReleaseDiff, type ModSource, type ReleaseMod, type ReleaseMods, type ReleasePackName, type SavedWhitelist, type WorldWhitelist } from "../api/contract";
import { startableReleases } from "../core/presets";
import { settingValueValid } from "../core/settings";
import { whitelistNameError } from "../core/whitelist";
import type { ControlPlaneSnapshot, Preset, SettingValue, World, WorldGameSettings, WorldSession } from "../model";
import { DemoState, initialState, Mutable } from "./data";
import { demoFixture } from "./flag";
import { stressState } from "./stress";

// One in-memory control plane for the whole demo. Transitions are scheduled in
// time rather than run by timers, so any read settles whatever has come due —
// the console's own polling is what makes a start look like a start.
let state: DemoState = demoFixture() === "stress" ? stressState() : initialState();

const START_MS = 7000;
const STOP_MS = 6000;
const LIFECYCLE_MS = 6000;
const ARCHIVE_MS = 4000;
const DELIVERY_MS = 3000;
// What earlier runs of each operation took, as the control plane would average them.
// A stop usually ends before the demo's does, so its ETA shows the over-time reading.
const USUAL = { start: { seconds: 10, samples: 10 }, stop: { seconds: 4, samples: 6 }, world: { seconds: 8, samples: 5 }, promote: { seconds: 12, samples: 4 } } as const;

const iso = () => new Date().toISOString();
const worldKey = (gameId: string, worldId: string) => `${gameId}/${worldId}`;

function hex(length: number, seed: number): string {
  let value = (seed * 2654435761) >>> 0;
  let out = "";
  while (out.length < length) {
    value = (value ^ (value << 13)) >>> 0;
    value = (value ^ (value >>> 17)) >>> 0;
    value = (value ^ (value << 5)) >>> 0;
    out += value.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

function settle(): void {
  const at = Date.now();
  const due = state.scheduled.filter((item) => item.at <= at);
  if (due.length === 0) return;
  state.scheduled = state.scheduled.filter((item) => item.at > at);
  for (const item of due) {
    item.apply(state);
    state.snapshot.operations = state.snapshot.operations.filter((operation) => operation.id !== item.operationId);
  }
  state.snapshot.observedAt = iso();
}

function schedule(type: "start" | "stop" | "world" | "promote", worldId: string, afterMs: number, apply: (state: DemoState) => void): string {
  state.counter += 1;
  const id = `op-${type}-${state.counter.toString().padStart(4, "0")}`;
  state.snapshot.operations.push({ id, type, status: "running", startedAt: iso(), worldId, expectedSeconds: USUAL[type].seconds, expectedSamples: USUAL[type].samples });
  state.scheduled.push({ operationId: id, at: Date.now() + afterMs, apply });
  state.snapshot.observedAt = iso();
  return id;
}

export function buildRelease(gameId: string, presetId: string, profileDigest: string, retryRelease?: string): { release: string; attempt: number } {
  settle();
  const preset = game(gameId).presets.find((item) => item.id === presetId);
  if (!preset) throw new Error("This preset is no longer available.");
  if (retryRelease !== undefined
    ? preset.build?.release !== retryRelease || (preset.build.profileDigest ?? preset.profileDigest) !== profileDigest || preset.build.state === "ready"
    : preset.profileDigest !== profileDigest) throw new Error("The build changed. Refresh before trying again.");
  if (preset.build?.state === "building") return preset.build;
  const retry = preset.build?.state === "failed";
  const resume = preset.build?.state === "starting";
  const release = retry || resume ? preset.build!.release : `${Date.now()}.${++state.counter}`;
  let attempt = 1;
  if (resume) attempt = preset.build!.attempt;
  else if (retry) attempt = preset.build!.attempt + 1;
  preset.build = { release, attempt, state: "building", requestedAt: iso(), profileDigest };
  preset.buildStatus = "building";
  state.scheduled.push({ operationId: `build-${gameId}-${presetId}`, at: Date.now() + 6000, apply: () => {
    preset.buildStatus = "ready";
    preset.build!.state = "ready";
    if (!preset.releases.includes(release)) preset.releases.push(release);
    preset.latestRelease = release;
  } });
  return { release, attempt };
}

function game(gameId: string) {
  const found = state.snapshot.games.find((item) => item.id === gameId);
  if (!found) throw new Error("This game is no longer in the control plane.");
  return found;
}

function world(gameId: string, worldId: string): Mutable<World> {
  const found = game(gameId).worlds.find((item) => item.id === worldId);
  if (!found) throw new Error("This world is no longer in the control plane.");
  return found;
}

function placementOf(worldId: string): "configured" | "fleet" {
  for (const owner of state.snapshot.games) {
    const found = owner.worlds.find((item) => item.id === worldId);
    if (found) return found.placement ?? "configured";
  }
  return "configured";
}

/** The one configured host; a host launched for a fleet world is never it (ADR-0054, ADR-0062). */
function configuredHost() {
  return state.snapshot.hosts.find((item) => item.provenance !== "launched")!;
}

const launchedHostId = (worldId: string) => `host-${worldId}`;

/** The session this world holds: a fleet world's own record, or its game's while that names it. */
function heldSession(gameId: string, target: Mutable<World>): Mutable<WorldSession> | null {
  if (target.placement === "fleet") return target.session ?? null;
  const lifecycle = game(gameId).lifecycle;
  return lifecycle?.activeWorldId === target.id ? lifecycle : null;
}

// As the API's blockingOperations: an operation that names no world blocks
// every world, a fleet world waits only for its own, and a configured world
// for any on the configured host its siblings share.
function requireIdle(worldId: string): void {
  const placement = placementOf(worldId);
  const blocking = state.snapshot.operations.filter((operation) => operation.worldId == null || operation.worldId === worldId ||
    (placement === "configured" && placementOf(operation.worldId) === "configured"));
  if (blocking.length > 0) throw new Error("Another control-plane operation is already running.");
}

function newGeneration(seed: number): string {
  return `gen-${hex(32, seed)}`;
}

function archive(gameId: string, target: Mutable<World>): void {
  state.counter += 1;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const entry: BackupEntry = {
    key: `worlds/${target.id}/archives/${stamp}`,
    archiveName: `${target.id}-${stamp}.tar.zst`,
    checksum: hex(64, state.counter * 7 + 11),
    generationId: target.release.generationId,
    sizeBytes: 150_000_000 + state.counter * 1_048_576,
    storedAt: iso(),
    release: target.release.activeRelease,
    releaseSource: target.release.activeRelease === null ? null : "recorded",
  };
  const key = worldKey(gameId, target.id);
  state.backups[key] = [entry, ...(state.backups[key] ?? [])];
}

export function snapshot(): ControlPlaneSnapshot {
  settle();
  return state.snapshot;
}

/** Refuses a start the world cannot take: it already runs, or the shared host is busy. */
function requireRoom(target: Mutable<World>, gameId: string, lifecycle: Mutable<WorldSession>): void {
  const running = "This world is already running.";
  if (target.placement === "fleet") {
    if (target.session && (target.session.activeSessionId || target.session.observedState !== "stopped")) throw new Error(running);
    return;
  }
  // The configured host runs one session at a time, kept on its game's record.
  const busy = state.snapshot.games.find((item) => item.lifecycle?.observedState !== "stopped");
  if (busy?.id === gameId && lifecycle.activeWorldId === target.id) throw new Error(running);
  if (busy) throw new Error(`The shared host already runs ${busy.displayName}. Stop that session first.`);
}

/** A world that was never created gets its first wipe on its first start. */
function materialize(target: Mutable<World>): void {
  if (target.materialization !== "not_created") return;
  target.materialization = "existing";
  const release = target.preset?.latestRelease ?? target.release.desiredRelease ?? "1.0";
  const generationId = newGeneration(state.counter + 3);
  target.wipes = [{ id: generationId, number: 1, state: "current", createdAt: iso(), closedAt: null, originRelease: release }];
  target.release = { state: "available", generationId, activeRelease: release, desiredRelease: release };
}

export function startSession(gameId: string, worldId: string): { result: "requested"; operationId: string } {
  settle();
  requireIdle(worldId);
  const target = world(gameId, worldId);
  if (!target.sessionControlAvailable) throw new Error("This world is not connected to a session workflow yet.");
  const lifecycle = game(gameId).lifecycle;
  if (!lifecycle) throw new Error("This game has no session workflow.");
  const fleet = target.placement === "fleet";
  requireRoom(target, gameId, lifecycle);
  materialize(target);

  const session: Mutable<WorldSession> = fleet
    ? { serverId: gameId, desiredState: "running", observedState: "starting", activeSessionId: null, activeWorldId: worldId, updatedAtEpochSeconds: 0, idle: null }
    : lifecycle;
  session.desiredState = "running";
  session.observedState = "starting";
  session.activeSessionId = `session-${state.counter + 100}`;
  session.activeWorldId = worldId;
  session.updatedAtEpochSeconds = Math.floor(Date.now() / 1000);
  if (fleet) {
    target.session = session;
    // A fleet start launches a host for this world alone.
    state.snapshot.hosts.push({ id: launchedHostId(worldId), name: `${target.displayName} host`, state: "pending", provenance: "launched", instanceType: "m7i-flex.large", availabilityZone: "eu-central-1b", launchedAt: null, publicIp: null });
  } else {
    configuredHost().state = "pending";
  }

  const operationId = schedule("start", worldId, START_MS, (current) => {
    session.observedState = "ready";
    session.readyAtEpochSeconds = Math.floor(Date.now() / 1000);
    session.updatedAtEpochSeconds = Math.floor(Date.now() / 1000);
    const box = current.snapshot.hosts.find((item) => item.id === (fleet ? launchedHostId(worldId) : configuredHost().id));
    if (box) {
      box.state = "running";
      box.launchedAt = iso();
      if (fleet) {
        current.counter += 1;
        box.publicIp = `203.0.113.${60 + (current.counter % 180)}`;
        if (target.connectivity === "raw") target.connectionAddress = `${box.publicIp}:${gamePort(gameId)}`;
      }
    }
  });
  return { result: "requested", operationId };
}

export function stopSession(gameId: string, worldId: string): { result: "requested" | "already_stopped"; operationId?: string } {
  settle();
  const target = world(gameId, worldId);
  const fleet = target.placement === "fleet";
  const session = fleet ? target.session ?? null : game(gameId).lifecycle;
  if (!session || session.observedState === "stopped") return { result: "already_stopped" };
  requireIdle(worldId);
  if (session.activeWorldId !== worldId) throw new Error("This world is not the one running.");
  session.observedState = "stopping";
  session.desiredState = "stopped";
  session.updatedAtEpochSeconds = Math.floor(Date.now() / 1000);
  const box = fleet ? state.snapshot.hosts.find((item) => item.id === launchedHostId(worldId)) : configuredHost();
  if (box) box.state = "stopping";

  const operationId = schedule("stop", worldId, STOP_MS, (current) => {
    session.observedState = "stopped";
    session.activeSessionId = null;
    session.activeWorldId = null;
    session.readyAtEpochSeconds = null;
    session.updatedAtEpochSeconds = Math.floor(Date.now() / 1000);
    if (fleet) {
      // A launched host ends with its session.
      current.snapshot.hosts = current.snapshot.hosts.filter((item) => item.id !== launchedHostId(worldId));
      if (target.connectivity === "raw") target.connectionAddress = null;
    } else {
      const shared = current.snapshot.hosts.find((item) => item.provenance !== "launched");
      if (shared) {
        shared.state = "stopped";
        shared.launchedAt = null;
      }
    }
    archive(gameId, target);
  });
  return { result: "requested", operationId };
}

/** The game's port, read from any world that has an address. */
function gamePort(gameId: string): string {
  const address = game(gameId).worlds.map((item) => item.connectionAddress).find((value) => value !== null);
  return address?.split(":").at(-1) ?? "25565";
}

/** A fleet world's promotion (ADR-0078): desired first, active once the target start passes. */
export function promoteWorld(gameId: string, worldId: string, release: string): { result: "requested"; operationId: string } {
  settle();
  requireIdle(worldId);
  const target = world(gameId, worldId);
  if (target.placement !== "fleet") throw new Error("Only a fleet world is promoted from the panel.");
  if (!(target.preset?.releases.includes(release) ?? false)) throw new Error("The selected release is no longer available. Refresh and try again.");
  if (target.release.activeRelease === null) throw new Error("This wipe has never started. Start a new wipe instead.");
  if (target.release.activeRelease === release) throw new Error("This release is already active.");
  if ((target.session?.idle?.playersOnline ?? 0) > 0) throw new Error("Players are online. Ask them to log off first.");
  archive(gameId, target);
  target.release = { ...target.release, desiredRelease: release };
  const operationId = schedule("promote", worldId, LIFECYCLE_MS, (current) => {
    const next = current.snapshot.games.find((item) => item.id === gameId)?.worlds.find((item) => item.id === worldId);
    if (next) next.release = { ...next.release, activeRelease: release, desiredRelease: release };
  });
  return { result: "requested", operationId };
}

export function worldLifecycle(gameId: string, worldId: string, action: "archive" | "regenerate" | "restore" | "purge", backupKey?: string, release?: string): { result: "requested"; operationId: string } {
  settle();
  requireIdle(worldId);
  const target = world(gameId, worldId);
  if (action === "purge" && target.materialization !== "archived") throw new Error("Archive this world before permanently deleting it.");
  if (action === "regenerate" && !(target.preset?.releases.includes(release ?? "") ?? false)) throw new Error("The selected release is no longer available. Refresh and try again.");
  if (action === "regenerate" && !startableReleases(target.preset!).includes(release ?? "")) throw new Error("That release was built from an older revision. Build the preset again.");
  if (action === "restore" && !(state.backups[worldKey(gameId, worldId)] ?? []).some((entry) => entry.key === backupKey)) throw new Error("This backup does not belong to the selected world.");

  const duration = action === "archive" || action === "purge" ? ARCHIVE_MS : LIFECYCLE_MS;
  const operationId = schedule("world", worldId, duration, (current) => {
    const owner = current.snapshot.games.find((item) => item.id === gameId);
    if (!owner) return;
    const next = owner.worlds.find((item) => item.id === worldId);
    if (!next) return;

    if (action === "archive") {
      archive(gameId, next);
      next.materialization = "archived";
      next.sessionControlAvailable = false;
      next.connectionAddress = null;
      const lifecycle = owner.lifecycle;
      if (lifecycle?.activeWorldId === worldId) lifecycle.activeWorldId = null;
      // Archive stops a fleet world's session, and its launched host goes with it.
      if (next.session) Object.assign(next.session, { desiredState: "stopped", observedState: "stopped", activeSessionId: null, activeWorldId: null, readyAtEpochSeconds: null, updatedAtEpochSeconds: Math.floor(Date.now() / 1000), idle: null });
      current.snapshot.hosts = current.snapshot.hosts.filter((item) => item.id !== launchedHostId(worldId));
      return;
    }
    if (action === "purge") {
      owner.worlds = owner.worlds.filter((item) => item.id !== worldId);
      current.snapshot.hosts = current.snapshot.hosts.filter((item) => item.id !== launchedHostId(worldId));
      delete current.backups[worldKey(gameId, worldId)];
      delete current.invitations[worldKey(gameId, worldId)];
      return;
    }

    // A wipe and a restore both close the current generation and open the next.
    archive(gameId, next);
    current.counter += 1;
    const generationId = newGeneration(current.counter * 13);
    let origin = release ?? next.release.activeRelease ?? "1.0";
    if (action === "restore") {
      const backup = (current.backups[worldKey(gameId, worldId)] ?? []).find((entry) => entry.key === backupKey);
      const sourceWipe = backup?.generationId ? next.wipes.find((wipe) => wipe.id === backup.generationId) : undefined;
      origin = backup?.release ?? sourceWipe?.originRelease ?? next.release.activeRelease ?? "1.0";
    }
    const open = next.wipes.find((wipe) => wipe.state === "current");
    if (open) {
      open.state = "closed";
      open.closedAt = iso();
    }
    next.wipes = [...next.wipes, { id: generationId, number: (next.wipes.at(-1)?.number ?? 0) + 1, state: "current", createdAt: iso(), closedAt: null, originRelease: origin }];
    next.release = { state: "available", generationId, activeRelease: origin, desiredRelease: origin };
  });
  return { result: "requested", operationId };
}

export function createWorld(gameId: string, presetId: string, displayName: string, release: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external"): { id: string; displayName: string } {
  settle();
  const owner = game(gameId);
  const preset = owner.presets.find((item) => item.id === presetId) as Preset | undefined;
  if (!preset) throw new Error("This preset is no longer available.");
  if (preset.releases.length === 0) throw new Error("This preset has no ready release yet.");
  if (!preset.releases.includes(release)) throw new Error("The selected release is no longer available. Refresh and try again.");
  if (!startableReleases(preset).includes(release)) throw new Error("That release was built from an older revision. Build the preset again.");
  if (displayName.trim().length === 0 || displayName.trim().length > 80) throw new Error("Enter a name between 1 and 80 characters.");

  state.counter += 1;
  const slug = displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "world";
  const id = `${gameId}-${slug}-${hex(8, state.counter * 29)}`;
  const generationId = newGeneration(state.counter * 17);
  owner.worlds.push({
    id,
    displayName: displayName.trim(),
    profileId: preset.id,
    sessionControlAvailable: true,
    worldLifecycleAvailable: true,
    connectivity,
    placement,
    ...(placement === "fleet" ? { session: null } : {}),
    auth: auth ?? null,
    materialization: "existing",
    preset: { id: preset.id, repository: preset.repository, commit: preset.commit, profileDigest: preset.profileDigest, releases: [...preset.releases], buildStatus: preset.buildStatus, latestRelease: preset.latestRelease, ...(preset.olderReleases ? { olderReleases: [...preset.olderReleases] } : {}) },
    wipes: [{ id: generationId, number: 1, state: "current", createdAt: iso(), closedAt: null, originRelease: release }],
    connectionAddress: connectivity === "zerotier" ? owner.worlds[0]?.connectionAddress ?? null : null,
    release: { state: "available", generationId, activeRelease: release, desiredRelease: release },
  });
  state.snapshot.observedAt = iso();
  return { id, displayName: displayName.trim() };
}

export function updateWorldSettings(gameId: string, worldId: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external"): void {
  settle();
  requireIdle(worldId);
  const owner = game(gameId);
  const target = world(gameId, worldId);
  if (heldSession(gameId, target)?.activeSessionId) throw new Error("Stop the world before changing its settings.");
  // A fleet world keeps its own session record; a configured one reads its game's.
  if (placement === "fleet") target.session = target.session ?? null;
  else delete target.session;
  target.placement = placement;
  target.connectivity = connectivity;
  target.auth = auth ?? null;
  target.connectionAddress = connectivity === "zerotier" ? owner.worlds.find((candidate) => candidate.connectivity === "zerotier" && candidate.id !== worldId)?.connectionAddress ?? null : null;
  state.snapshot.observedAt = iso();
}

export function backups(gameId: string, worldId: string): BackupInventory {
  settle();
  const entries = state.backups[worldKey(gameId, worldId)] ?? [];
  return { entries, unverified: entries.length > 2 ? 1 : 0, truncated: false };
}

const RANGE: Readonly<Record<MetricRange, { hours: number; period: number }>> = {
  "6h": { hours: 6, period: 300 },
  "24h": { hours: 24, period: 900 },
  "7d": { hours: 168, period: 3600 },
};

// A session's stretch of the window, as fractions of it, from the one it began to the one it ended.
type DemoSession = Readonly<{ from: number; to: number }>;

// A plausible two days: a session on one host, a gap while nothing ran, then a
// session on another. The server merges both hosts onto one grid, so the demo
// draws the merged result. Memory is probed every 15 minutes, so on the 5-minute
// grain its readings stand three slots apart and the server joins them with a
// line; the newest slots of a running session are not reported yet.
function worldMetricsOf(range: MetricRange, sessions: readonly DemoSession[], live: boolean): HostMetrics {
  const { hours, period } = RANGE[range];
  const end = Date.now();
  const count = Math.floor((hours * 3600) / period);
  const stride = Math.max(1, Math.round(900 / period));
  const pendingCount = live ? Math.max(1, Math.ceil(600 / period)) : 0;
  const slotAt = (index: number) => new Date(end - (count - index) * period * 1000).toISOString();
  const through = (index: number) => index / Math.max(count - 1, 1);
  const owner = (index: number) => sessions.findIndex((session) => through(index) >= session.from && through(index) < session.to);
  const firstOf = (session: number) => Array.from({ length: count }, (_, index) => index).find((index) => owner(index) === session) ?? 0;
  const reported = (index: number) => owner(index) >= 0 && index < count - pendingCount;
  const wave = (index: number) => 0.55 + 0.45 * Math.sin(index / 3.7) * Math.cos(index / 11.3);
  const ramp = (index: number) => Math.min(1, ((index - firstOf(owner(index))) / Math.max(count - 1, 1)) / 0.12 + 0.15);
  const measured = (peak: number) => Array.from({ length: count }, (_, index) => reported(index) ? Math.round(peak * ramp(index) * wave(index) * 100) / 100 : null);

  const cpu = measured(62);
  // One reading per probe from the session's first slot; a joined slot lies between two readings of one host while CPU reported.
  const probes = Array.from({ length: count }, (_, index) => reported(index) && (index - firstOf(owner(index))) % stride === 0 ? Math.round(71 * ramp(index) * wave(index) * 100) / 100 : null);
  const memory = probes.map((value, index): HostMetrics["series"][number]["points"][number] => ({ at: slotAt(index), value }));
  let last = -1;
  probes.forEach((value, index) => {
    if (value === null) return;
    if (last >= 0 && index - last > 1 && index - last <= stride && owner(index) === owner(last) && cpu.slice(last + 1, index).every((item) => item !== null)) {
      for (let slot = last + 1; slot < index; slot += 1) {
        memory[slot] = { at: slotAt(slot), value: Math.round((probes[last]! + (value - probes[last]!) * ((slot - last) / (index - last))) * 100) / 100, interpolated: true };
      }
    }
    last = index;
  });
  const pendingFrom = live ? slotAt(count - pendingCount) : undefined;
  const memoryPending = live && last + 1 < count ? slotAt(last + 1) : undefined;
  const plain = (id: string, label: string, unit: string, values: readonly (number | null)[], pending: string | undefined) => ({
    id, label, unit, points: values.map((value, index) => ({ at: slotAt(index), value })), ...(pending ? { pendingFrom: pending } : {}),
  });
  return {
    range,
    startedAt: new Date(end - hours * 3_600_000).toISOString(),
    endedAt: new Date(end).toISOString(),
    periodSeconds: period,
    series: [
      plain("cpu", "CPU", "percent", cpu, pendingFrom),
      { id: "memory", label: "Memory", unit: "percent", points: memory, ...(memoryPending ? { pendingFrom: memoryPending } : {}) },
      plain("networkIn", "Network in", "bytes", measured(4_800_000), pendingFrom),
      plain("networkOut", "Network out", "bytes", measured(9_200_000), pendingFrom),
    ],
    ...(pendingFrom ? { pendingFrom } : {}),
  };
}

// Like the API, the demo shows the hosts a world's sessions ran on: a fleet
// world its earlier session on another host, a gap, and its running session on
// its launched host; a stopped fleet world keeps that history. A configured
// world has only the session it holds on the shared host, and none when stopped.
export function worldMetrics(gameId: string, worldId: string, range: MetricRange): HostMetrics | null {
  settle();
  const target = world(gameId, worldId);
  if (target.materialization === "archived") return null;
  const session = heldSession(gameId, target);
  const live = !!session && session.observedState !== "stopped";
  if (target.placement === "fleet") return worldMetricsOf(range, [{ from: 0.1, to: 0.38 }, { from: 0.55, to: live ? 2 : 0.8 }], live);
  return live ? worldMetricsOf(range, [{ from: 0.34, to: 2 }], true) : null;
}

// The real console signs a short-lived S3 link; the demo runs in memory, so a
// small text file stands in for whatever would download.
function demoFile(title: string, facts: readonly string[], standsFor: string): string {
  const body = [title, ``, ...facts, ``, `The real console signs a short-lived S3 link here. The demo runs in memory,`, `so this file stands in for ${standsFor}.`].join("\n");
  return URL.createObjectURL(new Blob([body], { type: "text/plain" }));
}

export function packLink(gameId: string, worldId: string): { release: string; url: string } {
  settle();
  const target = world(gameId, worldId);
  const release = target.release.activeRelease;
  if (!release) throw new Error("This world has no release yet, so there is no pack to install.");
  return { release, url: demoFile("Spawnpoint demo client pack", [`World:   ${target.displayName} (${target.id})`, `Release: ${release}`], "the mod pack archive") };
}

// A release's server mods as its manifest lists them (ADR-0065). The demo has
// no store, so every release holds a fixed set and each later one adds a mod.
const DEMO_MODS: readonly (readonly [string, number])[] = [
  ["create-1.20.1-0.5.1.j.jar", 14_221_830],
  ["jei-1.20.1-forge-15.20.0.106.jar", 1_402_115],
  ["Mekanism-1.20.1-10.4.15.75.jar", 11_096_402],
  ["appliedenergistics2-forge-15.3.3.jar", 6_823_771],
  ["ftb-quests-forge-2001.4.9.jar", 1_218_903],
  ["sophisticatedbackpacks-1.20.1-3.21.2.1199.jar", 2_317_664],
  ["Jade-1.20.1-Forge-11.12.3.jar", 734_020],
  ["thermal_expansion-1.20.1-11.0.1.29.jar", 1_985_337],
];
const DEMO_SERVER_ONLY_MOD: readonly [string, number] = ["spark-1.10.53-forge.jar", 1_642_208];
const DEMO_PLAYERS_ONLY_MODS: readonly (readonly [string, number])[] = [
  ["Xaeros_Minimap_24.6.1_Forge_1.20.jar", 1_103_552],
  ["oculus-mc1.20.1-1.8.0.jar", 1_527_018],
];

// Where a release's build fetched each mod. A preset's first release stands for
// one built before sources were recorded: it names none.
const DEMO_MOD_SOURCES: Readonly<Record<string, ModSource>> = {
  "create-1.20.1-0.5.1.j.jar": "curseforge",
  "jei-1.20.1-forge-15.20.0.106.jar": "modrinth",
  "Mekanism-1.20.1-10.4.15.75.jar": "curseforge",
  "appliedenergistics2-forge-15.3.3.jar": "curseforge",
  "ftb-quests-forge-2001.4.9.jar": "curseforge",
  "sophisticatedbackpacks-1.20.1-3.21.2.1199.jar": "github",
  "Jade-1.20.1-Forge-11.12.3.jar": "modrinth",
  "thermal_expansion-1.20.1-11.0.1.29.jar": "curseforge",
  "spark-1.10.53-forge.jar": "modrinth",
  "Xaeros_Minimap_24.6.1_Forge_1.20.jar": "modrinth",
  "oculus-mc1.20.1-1.8.0.jar": "modrinth",
};

// A stable stand-in for a SHA-256: 64 hex digits derived from the name.
function demoDigest(text: string): string {
  let hash = 2166136261;
  let hex = "";
  let round = 0;
  while (hex.length < 64) {
    for (const char of `${text}#${round}`) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0;
    hex += hash.toString(16).padStart(8, "0");
    round += 1;
  }
  return hex.slice(0, 64);
}

export function releaseMods(gameId: string, presetId: string, release: string): ReleaseMods {
  settle();
  const preset = state.snapshot.games.find((game) => game.id === gameId)?.presets.find((candidate) => candidate.id === presetId);
  if (!preset?.releases.includes(release)) throw new Error(`Release ${release} is not in the store.`);
  const files = DEMO_MODS.slice(0, 5 + preset.releases.indexOf(release));
  const recorded = preset.releases.indexOf(release) > 0;
  const mod = ([file, bytes]: readonly [string, number]): ReleaseMod => ({ file, bytes, sha256: demoDigest(file), ...(recorded && DEMO_MOD_SOURCES[file] ? { source: DEMO_MOD_SOURCES[file] } : {}) });
  // From 1.2 the industrial preset keeps side lists (ADR-0069): a profiler only
  // the server runs, and a minimap and shaders only players install.
  if (presetId !== "industrial" || release === "1.1") return { release, mods: files.map(mod), clientMods: null };
  return {
    release,
    mods: [...files, DEMO_SERVER_ONLY_MOD].map(mod),
    clientMods: [...files, ...DEMO_PLAYERS_ONLY_MODS].map(mod),
  };
}

// The demo keeps no plans: every release is diffed from its mods by file name.
// With no `from`, the previous release stands for what the build compared; the
// first release has nothing before it, which is a release with no plan.
export function releaseDiff(gameId: string, presetId: string, release: string, from: string | null): ReleaseDiff | null {
  const releases = state.snapshot.games.find((game) => game.id === gameId)?.presets.find((candidate) => candidate.id === presetId)?.releases ?? [];
  const previous = from ?? releases[releases.indexOf(release) - 1] ?? null;
  if (previous === null) {
    releaseMods(gameId, presetId, release);
    return null;
  }
  const next = releaseMods(gameId, presetId, release);
  const old = releaseMods(gameId, presetId, previous);
  const diffMod = (mod: ReleaseMod): DiffMod => ({ file: mod.file, sha256: mod.sha256, bytes: mod.bytes, side: null, modIds: null });
  const classes = (before: readonly ReleaseMod[], after: readonly ReleaseMod[]): DiffClasses<DiffMod> => {
    const named = (list: readonly ReleaseMod[], file: string) => list.find((mod) => mod.file === file);
    return {
      added: after.filter((mod) => !named(before, mod.file)).map(diffMod),
      removed: before.filter((mod) => !named(after, mod.file)).map(diffMod),
      changed: after.flatMap((mod) => { const was = named(before, mod.file); return was && was.sha256 !== mod.sha256 ? [{ from: diffMod(was), to: diffMod(mod) }] : []; }),
      unchanged: after.filter((mod) => named(before, mod.file)?.sha256 === mod.sha256).length,
    };
  };
  const clientOnly = (mods: ReleaseMods) => (mods.clientMods ?? []).filter((mod) => !mods.mods.some((server) => server.file === mod.file));
  const config = (text: string) => ({ path: "config/create-server.toml", sha256: demoDigest(text), bytes: 4_812 });
  const same = <T,>(value: T): DiffValue<T> => ({ from: value, to: value, changed: false });
  return {
    release,
    from: previous,
    source: from === null ? "plan" : "manifests",
    gameVersion: same("1.20.1"),
    loader: same({ type: "forge", version: "47.4.10" }),
    runtimeImage: same(null),
    serverMods: classes(old.mods, next.mods),
    overrides: [{ root: "config", added: [], removed: [], changed: [{ from: config(previous), to: config(release) }], unchanged: 41 }],
    clientMods: classes(clientOnly(old), clientOnly(next)),
    clientPack: { from: null, to: null, changed: false },
  };
}

export function modLink(gameId: string, presetId: string, release: string, sha256: string): FileLink {
  const mods = releaseMods(gameId, presetId, release);
  const mod = [...mods.mods, ...(mods.clientMods ?? [])].find((candidate) => candidate.sha256 === sha256);
  if (!mod) throw new Error("This release no longer lists that mod.");
  return { url: demoFile("Spawnpoint demo mod", [`File:    ${mod.file}`, `Release: ${presetId} ${release}`], "the mod's jar"), expiresIn: 900 };
}

export function releasePackLink(gameId: string, presetId: string, release: string, pack: ReleasePackName): FileLink {
  const mods = releaseMods(gameId, presetId, release);
  if (mods.clientMods === null) throw new Error(`Release ${release} has no ${pack} pack yet.`);
  return { url: demoFile(`Spawnpoint demo ${pack} pack`, [`Preset:  ${presetId}`, `Release: ${release}`], `the ${pack} pack`), expiresIn: 900 };
}

export function backupLink(gameId: string, worldId: string, key: string): FileLink {
  settle();
  const entry = (state.backups[worldKey(gameId, worldId)] ?? []).find((candidate) => candidate.key === key);
  if (!entry) throw new Error("This backup is no longer in the store. Refresh the list.");
  return { url: demoFile("Spawnpoint demo world backup", [`World:   ${world(gameId, worldId).displayName}`, `Archive: ${entry.archiveName}`], "the world archive"), expiresIn: 300 };
}

// A world's whitelist (ADR-0066): kept on its record; a running world reloads it.
export function whitelist(gameId: string, worldId: string): WorldWhitelist {
  settle();
  if (!world(gameId, worldId).worldLifecycleAvailable) throw new Error("This world has no record to keep a whitelist in.");
  const kept = state.whitelists[worldKey(gameId, worldId)];
  if (kept) return { managed: true, names: [...kept.names], updatedAt: kept.updatedAt, updatedBy: kept.updatedBy };
  // No list of its own: a running server's list is shown, a stopped world has none.
  const running = heldSession(gameId, world(gameId, worldId))?.observedState === "ready";
  return { managed: false, names: running ? [...(state.serverWhitelists[worldKey(gameId, worldId)] ?? [])] : [], updatedAt: null, updatedBy: null };
}

export function updateWhitelist(gameId: string, worldId: string, names: readonly string[]): SavedWhitelist {
  settle();
  const target = world(gameId, worldId);
  if (!target.worldLifecycleAvailable) throw new Error("This world has no record to keep a whitelist in.");
  names.forEach((name, index) => {
    const error = whitelistNameError(name, names.slice(0, index));
    if (error) throw new Error(`${name}: ${error}`);
  });
  const kept = { names: [...names], updatedAt: iso(), updatedBy: "DrArzter" };
  state.whitelists[worldKey(gameId, worldId)] = kept;
  const running = heldSession(gameId, target)?.observedState === "ready";
  return { managed: true, ...kept, applied: running ? "reloading" : "next_start" };
}

// A world's game settings (ADR-0064): kept on its record, checked against its
// game's definitions, taken by a running world at its next start.
export function updateGameSettings(gameId: string, worldId: string, values: Readonly<Record<string, SettingValue>>): WorldGameSettings {
  settle();
  const definitions = state.snapshot.games.find((game) => game.id === gameId)?.settings ?? [];
  const target = world(gameId, worldId);
  if (!target.gameSettings) throw new Error("This world has no record to keep settings in.");
  for (const [id, value] of Object.entries(values)) {
    const setting = definitions.find((candidate) => candidate.id === id);
    if (!setting || !settingValueValid(setting, value)) throw new Error(`${setting?.label ?? id} has a value the game does not accept.`);
  }
  const saved = { values: { ...values }, updatedAt: iso() };
  target.gameSettings = saved;
  state.snapshot.observedAt = iso();
  return saved;
}

export function candidates(): AccessCandidate[] {
  settle();
  return state.candidates;
}

export function identities(): AccessIdentity[] {
  settle();
  return state.identities;
}

export function roles() {
  return state.roles;
}

const sameAccount = (platform: string, platformUserId: string) => (item: { platform: string; platformUserId: string }) =>
  item.platform === platform && item.platformUserId === platformUserId;

export function approveCandidate(platform: string, platformUserId: string, roleId: string): { id: string; displayName: string; roleId: string } {
  const candidate = state.candidates.find(sameAccount(platform, platformUserId));
  if (!candidate) throw new Error("This account is no longer waiting for a decision.");
  if (!state.roles.some((role) => role.id === roleId)) throw new Error("This role no longer exists.");
  const identity: Mutable<AccessIdentity> = {
    id: `identity-${platformUserId}`,
    displayName: candidate.displayName,
    roleId,
    directGrants: [],
    links: [{ platform, value: platformUserId, handle: candidate.username ?? candidate.email, verified: platform !== "password" }],
  };
  state.identities = [...state.identities, identity];
  state.candidates = state.candidates.filter((item) => !sameAccount(platform, platformUserId)(item));
  state.delivery[identity.id] = "bot_unavailable";
  return { id: identity.id, displayName: identity.displayName, roleId };
}

export function dismissCandidate(platform: string, platformUserId: string): void {
  state.candidates = state.candidates.filter((item) => !sameAccount(platform, platformUserId)(item));
}

export function setIdentityRole(identityId: string, roleId: string): void {
  const identity = state.identities.find((item) => item.id === identityId);
  if (!identity) throw new Error("This user is no longer in the directory.");
  if (identity.roleId === "owner") throw new Error("You cannot change your own Owner role.");
  if (!state.roles.some((role) => role.id === roleId)) throw new Error("This role no longer exists.");
  identity.roleId = roleId;
}

// The demo signs in as identity-owner; only the access part changes.
export function deleteIdentity(identityId: string): void {
  if (identityId === "identity-owner") throw new Error(identityDeletionRefusal(409, "self_delete_forbidden"));
  const identity = state.identities.find((item) => item.id === identityId);
  if (!identity) return;
  if (identity.roleId === "owner" && state.identities.filter((item) => item.roleId === "owner").length <= 1) throw new Error(identityDeletionRefusal(409, "last_owner"));
  state.identities = state.identities.filter((item) => item.id !== identityId);
  delete state.delivery[identityId];
}

export function subscriptions(): SubscriptionState {
  return state.subscriptions;
}

export function setSubscriptions(next: SubscriptionState): SubscriptionState {
  state.subscriptions = { ...state.subscriptions, ...next };
  return state.subscriptions;
}

export function appearance(): AppearancePreference {
  return state.appearance;
}

export function setAppearance(next: AppearancePreference): AppearancePreference {
  state.appearance = next;
  return state.appearance;
}

export function recipients(): InvitationRecipient[] {
  settle();
  return state.identities
    .filter((identity) => identity.id !== "identity-owner")
    .map((identity) => ({ id: identity.id, displayName: identity.displayName, delivery: state.delivery[identity.id] ?? "ready" }));
}

export function invitations(gameId: string, worldId: string): InvitationSummary[] {
  settle();
  return state.invitations[worldKey(gameId, worldId)] ?? [];
}

export function sendInvitation(gameId: string, worldId: string, audience: "broadcast" | "direct", recipientIds: readonly string[]): void {
  settle();
  const reachable = recipients().filter((item) => item.delivery === "ready");
  const targets = audience === "broadcast" ? reachable.length : recipientIds.length;
  if (audience === "direct" && targets === 0) throw new Error("One or more selected players are no longer available.");
  state.counter += 1;
  const id = `invite-${state.counter}`;
  const key = worldKey(gameId, worldId);
  const record: InvitationSummary = {
    id,
    audience,
    status: "DELIVERING",
    recipientCount: audience === "direct" ? recipientIds.length : null,
    targetCount: targets,
    successCount: null,
    failureCount: null,
    createdAt: iso(),
  };
  state.invitations[key] = [record, ...(state.invitations[key] ?? [])];
  window.setTimeout(() => {
    const list = state.invitations[key];
    const stored = list?.find((item) => item.id === id);
    if (!list || !stored) return;
    const delivered = audience === "broadcast" ? targets : recipientIds.filter((recipientId) => (state.delivery[recipientId] ?? "ready") === "ready").length;
    let status: InvitationSummary["status"] = "PARTIAL";
    if (targets === 0) status = "NO_RECIPIENTS";
    else if (delivered === targets) status = "DELIVERED";
    else if (delivered === 0) status = "FAILED";
    state.invitations[key] = list.map((item) => item.id === id
      ? { ...item, status, successCount: delivered, failureCount: targets - delivered }
      : item);
  }, DELIVERY_MS);
}

// --- console (ADR-0063) ----------------------------------------------------------
// The demo answers the way a Minecraft server would, a moment later, so the
// console shows a command waiting and then settling as it does live.

const CONSOLE_REPLY_MS = 900;

function demoReply(command: string): string {
  const [verb = "", ...rest] = command.replace(/^\/+/, "").split(/\s+/);
  switch (verb.toLowerCase()) {
    case "list": return "There are 3 of a max of 20 players online: Alex, Mira, Kira";
    case "say": return `[Server] ${rest.join(" ")}`;
    case "save-all": return "Saving the game (this may take a moment!)\nSaved the game";
    case "time": return rest[0] === "set" ? "Set the time to 1000" : "The time is 6000";
    case "weather": return "Set the weather to clear";
    case "help": return "/list, /say <message>, /save-all, /time set <value>, /weather <type>, /whitelist ...";
    default: return `Unknown or incomplete command, see below for error\n${command}<--[HERE]`;
  }
}

export function consoleHistory(gameId: string, worldId: string): ConsoleEntry[] {
  settle();
  return state.console[worldKey(gameId, worldId)] ?? [];
}

export function runConsoleCommand(gameId: string, worldId: string, command: string): ConsoleEntry {
  settle();
  const game = state.snapshot.games.find((item) => item.id === gameId);
  const world = game?.worlds.find((item) => item.id === worldId);
  if (!game || !world) throw new Error("Spawnpoint does not know this world. Refresh and try again.");
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.length > 256) throw new Error("A command is one line of at most 256 characters.");
  if (["stop", "save-off"].includes((trimmed.replace(/^\/+/, "").split(/\s+/)[0] ?? "").toLowerCase())) {
    throw new Error("Stopping the game here would skip the verified backup. Use Stop on the world page.");
  }
  if (heldSession(gameId, world)?.observedState !== "ready") throw new Error("This world is not running. Start it first.");
  state.counter += 1;
  const key = worldKey(gameId, worldId);
  const entry: ConsoleEntry = { id: `console-${state.counter + 100}`, at: iso(), identityId: "identity-owner", displayName: "DrArzter", worldId, command: trimmed, status: "pending", output: null };
  state.console[key] = [entry, ...(state.console[key] ?? [])].slice(0, 30);
  window.setTimeout(() => {
    const list = state.console[key];
    const index = list?.findIndex((item) => item.id === entry.id) ?? -1;
    if (!list || index < 0) return;
    list[index] = { ...entry, status: "succeeded", output: demoReply(trimmed) };
  }, CONSOLE_REPLY_MS);
  return entry;
}
