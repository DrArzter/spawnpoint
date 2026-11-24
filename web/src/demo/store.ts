import type { AccessCandidate, AccessIdentity, AccessRole, AccessRoleDirectory, AccessRoleDraft, AppearancePreference, BackupEntry, BackupInventory, InvitationRecipient, InvitationSummary, SubscriptionState } from "../api/contract";
import { ApiError, identityDeletionRefusal, type ApiErrorCode, type HostLogLine, type PromotionResult, type ConsoleEntry, type FileLink, type DiffClasses, type DiffMod, type DiffValue, type HostMetrics, type MetricRange, type OperationProgress, type OperationStep, type ReleaseDiff, type ModSource, type ReleaseMod, type ReleaseModPage, type ReleaseModQuery, type ReleasePackName, type SavedWhitelist, type WorldWhitelist } from "../api/contract";
import { API_ERROR_TEXT } from "../api/error-text";
import { startableReleases } from "../core/presets";
import { settingValueValid } from "../core/settings";
import { whitelistNameError } from "../core/whitelist";
import type { ControlPlaneSnapshot, Preset, SettingValue, World, WorldGameSettings, WorldSession } from "../model";
import { DemoState, demoSession, initialState, Mutable, PERMISSION_CATALOGUE, type OperationPlan } from "./data";
import { demoFixture, demoOperation } from "./flag";
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
const USUAL = { start: { seconds: 10, samples: 10 }, stop: { seconds: 4, samples: 6 }, world: { seconds: 8, samples: 5 }, promote: { seconds: 30, samples: 4 } } as const;

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

function schedule(type: OperationPlan["type"], worldId: string, afterMs: number, apply: (state: DemoState) => void, plan: Partial<OperationPlan> = {}): string {
  state.counter += 1;
  const id = `op-${type}-${state.counter.toString().padStart(4, "0")}`;
  state.snapshot.operations.push({ id, type, status: "running", startedAt: iso(), worldId, expectedSeconds: USUAL[type].seconds, expectedSamples: USUAL[type].samples });
  state.scheduled.push({ operationId: id, at: Date.now() + afterMs, apply });
  state.progress[id] = { type, worldId, startedAt: Date.now(), durationMs: afterMs, ...plan };
  state.snapshot.observedAt = iso();
  return id;
}

const step = (key: string, label: string): OperationStep => ({ key, label });
type Phase = Readonly<{ weight: number; step: OperationStep; children?: readonly Readonly<{ weight: number; step: OperationStep }>[] }>;

// The steps of each operation and their share of its run, as the workflows name them.
const START_STEPS = [
  { weight: 5, step: step("start.launching_host", "Launching the host") },
  { weight: 5, step: step("start.waiting_host", "Waiting for the host") },
  { weight: 4, step: step("start.starting_server", "Starting the server") },
] as const;
const PHASES: Readonly<Record<OperationPlan["type"], readonly Phase[]>> = {
  promote: [
    { weight: 2, step: step("promote.checking_release", "Checking the release") },
    { weight: 4, step: step("promote.stopping_server", "Stopping the server") },
    { weight: 5, step: step("promote.keeping_backup", "Keeping the backup") },
    { weight: 14, step: step("promote.starting_release", "Starting on the new release"), children: START_STEPS },
    { weight: 2, step: step("promote.recording_release", "Recording the release") },
  ],
  start: START_STEPS,
  stop: [
    { weight: 1, step: step("stop.checking", "Checking the session") },
    { weight: 3, step: step("stop.saving", "Saving and stopping the server") },
    { weight: 1, step: step("stop.releasing_host", "Releasing the host") },
  ],
  world: [
    { weight: 1, step: step("world.checking", "Checking the server") },
    { weight: 3, step: step("world.stopping_backing_up", "Stopping and backing up") },
    { weight: 2, step: step("world.applying", "Applying the change") },
  ],
};

/** The step an operation is in after `fraction` of its run, and the child step inside it. */
function phaseAt(type: OperationPlan["type"], fraction: number): Pick<OperationProgress, "step" | "child"> {
  const phases = PHASES[type];
  const total = phases.reduce((sum, phase) => sum + phase.weight, 0);
  let at = Math.min(Math.max(fraction, 0), 0.9999) * total;
  for (const phase of phases) {
    if (at >= phase.weight) { at -= phase.weight; continue; }
    let inner = at;
    const child = phase.children?.find((candidate) => { if (inner >= candidate.weight) { inner -= candidate.weight; return false; } return true; });
    return { step: phase.step, child: child ? { type: "start", step: child.step } : null };
  }
  return { step: phases.at(-1)!.step, child: null };
}

// The host's own lines of a start, by the share of the start they appear at.
const HOST_LINES: readonly Readonly<{ at: number; kind: HostLogLine["kind"]; text: string }>[] = [
  { at: 0, kind: "step", text: "Session started (0 s)" },
  { at: 0.12, kind: "step", text: "World prepared (14 s)" },
  { at: 0.24, kind: "step", text: "Release pointer read (15 s)" },
  { at: 0.4, kind: "result", text: "Downloaded: 1659" },
  { at: 0.46, kind: "step", text: "Release downloaded (1209 s)" },
  { at: 0.58, kind: "step", text: "Release reconciled (1214 s)" },
  { at: 0.7, kind: "step", text: "Game starting (1215 s)" },
  { at: 0.78, kind: "container", text: "Container spawnpoint-demo-mc-1 Started" },
  { at: 0.9, kind: "step", text: "Game ready (1252 s)" },
];
const HOST_FAULTS: readonly Readonly<{ at: number; kind: HostLogLine["kind"]; text: string }>[] = [
  { at: 0.8, kind: "game", text: "[22:41:10] [Server thread/ERROR]: java.lang.IllegalStateException: Mod loading has failed: examplemod-neoforge-1.21.1-12.3.4-build.5678-with-a-very-long-file-name.jar" },
  { at: 0.84, kind: "error", text: "the game did not report ready" },
];

// A start, or the start inside a promotion, prints these lines over its run.
function hostLogOf(plan: OperationPlan, ranMs: number): readonly HostLogLine[] {
  if (plan.type !== "start" && plan.type !== "promote") return [];
  const from = plan.type === "promote" ? 0.4 : 0;
  const span = plan.type === "promote" ? 0.5 : 0.95;
  const script = plan.failure ? [...HOST_LINES.filter((line) => line.at < 0.78), ...HOST_FAULTS] : HOST_LINES;
  return script
    .map((line) => ({ line, time: (from + line.at * span) * plan.durationMs }))
    .filter(({ time }) => time <= ranMs)
    .map(({ line, time }) => ({ at: new Date(plan.startedAt + time).toISOString(), kind: line.kind, text: line.text }));
}

/** One operation of a world; null when the control plane does not know it (the API's 404). */
export function operationProgress(gameId: string, worldId: string, operationId: string): OperationProgress | null {
  settle();
  const plan = state.progress[operationId];
  const owner = state.snapshot.games.find((item) => item.id === gameId);
  if (plan?.worldId !== worldId || !owner?.worlds.some((item) => item.id === worldId)) return null;
  const running = state.snapshot.operations.some((operation) => operation.id === operationId);
  const usual = USUAL[plan.type];
  const base = { id: operationId, type: plan.type, startedAt: new Date(plan.startedAt).toISOString(), expectedSeconds: usual.seconds, expectedSamples: usual.samples };
  if (running) {
    const ran = Math.min(Date.now() - plan.startedAt, plan.pinAtMs ?? Number.POSITIVE_INFINITY);
    return { ...base, status: "running", stoppedAt: null, elapsedSeconds: Math.floor((Date.now() - plan.startedAt) / 1000), ...phaseAt(plan.type, ran / plan.durationMs), result: null, failure: null, caught: caughtOf(plan), hostLog: hostLogOf(plan, ran) };
  }
  return {
    ...base,
    status: plan.failure ? "failed" : "succeeded",
    stoppedAt: new Date(plan.startedAt + plan.durationMs).toISOString(),
    elapsedSeconds: Math.floor(plan.durationMs / 1000),
    step: null,
    child: null,
    result: plan.failure || plan.type !== "promote" ? null : "promoted",
    failure: plan.failure ?? null,
    caught: caughtOf(plan),
    ...(plan.failure ? { hostLog: hostLogOf(plan, plan.durationMs) } : {}),
  };
}

function caughtOf(plan: OperationPlan): OperationProgress["caught"] {
  return plan.caught ? { error: plan.caught.error, cause: plan.caught.cause, step: step(plan.caught.stepKey, "Starting on the new release") } : null;
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
  // As the API locates it (lambdas world-session.ts): a configured world's session is its game's while that names it.
  for (const owner of state.snapshot.games) {
    for (const item of owner.worlds) {
      if (item.placement === "configured") item.session = owner.lifecycle?.activeWorldId === item.id ? { ...owner.lifecycle } : null;
    }
  }
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
    state.snapshot.hosts.push({ id: launchedHostId(worldId), name: `${target.displayName} host`, state: "pending", provenance: "launched", instanceType: "m7i-flex.large", availabilityZone: "eu-central-1b", launchedAt: null });
  } else {
    configuredHost().state = "pending";
  }

  const operationId = schedule("start", worldId, START_MS, (current) => {
    if (target.release.activeRelease === null) target.release = { ...target.release, activeRelease: target.release.desiredRelease, runCount: 1 };
    session.observedState = "ready";
    session.readyAtEpochSeconds = Math.floor(Date.now() / 1000);
    session.updatedAtEpochSeconds = Math.floor(Date.now() / 1000);
    const box = current.snapshot.hosts.find((item) => item.id === (fleet ? launchedHostId(worldId) : configuredHost().id));
    if (box) {
      box.state = "running";
      box.launchedAt = iso();
      if (fleet) {
        current.counter += 1;
        if (target.connectivity === "raw") target.connectionAddress = `203.0.113.${60 + (current.counter % 180)}:${gamePort(gameId)}`;
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

/** A wipe that never started takes the release at once: no backup, no operation (ADR-0078). */
function switchRelease(gameId: string, target: Mutable<World>, release: string): PromotionResult {
  const generationId = target.release.generationId;
  if (!startableReleases(target.preset!).includes(release)) throw new Error("That release was built from an older revision. Build the preset again.");
  const archived = (state.backups[worldKey(gameId, target.id)] ?? []).some((entry) => entry.generationId === generationId);
  if ((target.release.runCount ?? 0) > 0 || archived) throw new Error("This wipe has already started. Refresh to update it with a backup.");
  const sessionState = heldSession(gameId, target)?.observedState ?? "stopped";
  if (sessionState !== "stopped") throw new Error("A session is starting or running. Stop it first.");
  const current = target.wipes.find((wipe) => wipe.id === generationId);
  if (target.release.desiredRelease === release && current?.originRelease === release) throw new Error("This release is already selected.");
  target.release = { ...target.release, desiredRelease: release };
  if (current) target.wipes = target.wipes.map((wipe) => wipe === current ? { ...wipe, originRelease: release } : wipe);
  state.snapshot.observedAt = iso();
  return { result: "switched" };
}

/** A fleet world's promotion (ADR-0078): desired first, active once the target start passes. */
/** Negative when `a` is the older `MAJOR.MINOR` release. */
function releaseOrder(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor === bMajor ? aMinor - bMinor : aMajor - bMajor;
}

export function promoteWorld(gameId: string, worldId: string, release: string): PromotionResult {
  settle();
  requireIdle(worldId);
  const target = world(gameId, worldId);
  if (target.placement !== "fleet") throw new Error("Only a fleet world is promoted from the panel.");
  if (!(target.preset?.releases.includes(release) ?? false)) throw new Error("The selected release is no longer available. Refresh and try again.");
  if (target.release.activeRelease === null) return switchRelease(gameId, target, release);
  if (target.release.activeRelease === release) throw new Error("This release is already active.");
  // As the API does: going back is a restore of a backup, not an update.
  if (releaseOrder(release, target.release.activeRelease) < 0) throw new Error("This release is older than the active one. Restore a backup to go back.");
  if ((target.session?.idle?.playersOnline ?? 0) > 0) throw new Error("Players are online. Ask them to log off first.");
  archive(gameId, target);
  target.release = { ...target.release, desiredRelease: release };
  // The world runs on the new release after its update; the idle watchdog stops it (ADR-0078).
  const wasRunning = Boolean(target.session?.activeSessionId);
  const operationId = schedule("promote", worldId, LIFECYCLE_MS, (current) => {
    const next = current.snapshot.games.find((item) => item.id === gameId)?.worlds.find((item) => item.id === worldId);
    if (!next) return;
    next.release = { ...next.release, activeRelease: release, desiredRelease: release };
    if (!wasRunning) {
      const now = Math.floor(Date.now() / 1000);
      next.session = { serverId: gameId, desiredState: "running", observedState: "ready", activeSessionId: `session-promote-${worldId}`, activeWorldId: worldId, readyAtEpochSeconds: now, updatedAtEpochSeconds: now, idle: null };
    }
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
  // As the API does: a world reached outside ZeroTier must say how players authenticate.
  if (connectivity !== "zerotier" && auth === undefined) throw new Error("A public world needs an authentication choice.");

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
    session: null,
    auth: auth ?? null,
    materialization: "existing",
    preset: { id: preset.id, repository: preset.repository, commit: preset.commit, profileDigest: preset.profileDigest, releases: [...preset.releases], buildStatus: preset.buildStatus, latestRelease: preset.latestRelease, ...(preset.olderReleases ? { olderReleases: [...preset.olderReleases] } : {}) },
    wipes: [{ id: generationId, number: 1, state: "current", createdAt: iso(), closedAt: null, originRelease: release }],
    connectionAddress: connectivity === "zerotier" ? owner.worlds[0]?.connectionAddress ?? null : null,
    // Nothing has run yet: the first start commits the release as active.
    release: { state: "available", generationId, activeRelease: null, desiredRelease: release, runCount: 0 },
    gameSettings: { values: {}, updatedAt: null },
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
  // A fleet world keeps its own session record; a configured one's is its game's, located on read.
  if (placement !== target.placement) target.session = null;
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

/** A demo release's mods of both sides; the panel reads them a page at a time through `releaseModPage`. */
type DemoReleaseMods = Readonly<{ release: string; mods: readonly ReleaseMod[]; clientMods: readonly ReleaseMod[] | null }>;

export function releaseMods(gameId: string, presetId: string, release: string): DemoReleaseMods {
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

const demoSourceRank = (source: ModSource | undefined): number => source === undefined ? 3 : ["curseforge", "modrinth", "github"].indexOf(source);

/** One page of a release's mods, searched, filtered, sorted and paged here as the API does it. */
export function releaseModPage(gameId: string, presetId: string, release: string, query: ReleaseModQuery): ReleaseModPage {
  const { mods: server, clientMods } = releaseMods(gameId, presetId, release);
  const held = new Set(server.map((mod) => mod.sha256));
  const all = [...server, ...(clientMods ?? []).filter((mod) => !held.has(mod.sha256))];
  const sources = (["curseforge", "modrinth", "github", "unknown"] as const)
    .map((source) => ({ source, count: all.filter((mod) => (mod.source ?? "unknown") === source).length }))
    .filter((entry) => entry.count > 0);
  const needle = query.search.toLowerCase();
  const sign = query.order === "asc" ? 1 : -1;
  const byName = (left: ReleaseMod, right: ReleaseMod) => left.file.localeCompare(right.file, "en") || left.sha256.localeCompare(right.sha256);
  const orders = {
    name: byName,
    source: (left: ReleaseMod, right: ReleaseMod) => demoSourceRank(left.source) - demoSourceRank(right.source),
    size: (left: ReleaseMod, right: ReleaseMod) => left.bytes - right.bytes,
  };
  const matching = all
    .filter((mod) => (needle === "" || mod.file.toLowerCase().includes(needle)) && (query.source === null || (mod.source ?? "unknown") === query.source))
    .sort((left, right) => sign * orders[query.sort](left, right) || byName(left, right));
  const pages = Math.max(1, Math.ceil(matching.length / query.pageSize));
  const page = Math.min(Math.max(1, query.page), pages);
  return {
    release,
    split: clientMods !== null,
    all: all.length,
    total: matching.length,
    page,
    pages,
    pageSize: query.pageSize,
    sources: sources.length === 1 && sources[0]?.source === "unknown" ? [] : sources,
    mods: matching.slice((page - 1) * query.pageSize, page * query.pageSize),
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
  const clientOnly = (mods: DemoReleaseMods) => (mods.clientMods ?? []).filter((mod) => !mods.mods.some((server) => server.file === mod.file));
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

// The demo plays the backend here: it applies the owner rules for the caller it
// signs in as, and serves the answers (`assignable`, `canDelete`) the way the API does.
const caller = demoSession.identity.id;
const callerHolds = (permission: string) => demoSession.role?.permissions.includes(permission) ?? false;
const isProtected = (roleId: string) => state.roles.some((role) => role.id === roleId && role.protected);
const roleOf = (roleId: string) => state.roles.find((role) => role.id === roleId);
const holdersOf = (roleId: string) => state.identities.filter((identity) => identity.roleId === roleId).length;
// No escalation (ADR-0083): a caller works with a role only while holding every permission in it.
const holdsAll = (permissions: readonly string[]) => permissions.every(callerHolds);
const canAssign = (roleId: string) => callerHolds("access.manage") && holdsAll(roleOf(roleId)?.permissions ?? []);

export function identities(): AccessIdentity[] {
  settle();
  return state.identities.map((identity) => ({
    ...identity,
    canDelete: identity.id !== caller && canAssign(identity.roleId),
  }));
}

const editable = (role: { protected: boolean; permissions: readonly string[] }) => callerHolds("access.manage") && !role.protected && holdsAll(role.permissions);
const deletable = (role: { id: string; protected: boolean; builtIn: boolean; permissions: readonly string[] }) => editable(role) && !role.builtIn && holdersOf(role.id) === 0 && role.id !== state.defaultRoleId;
const served = (role: DemoState["roles"][number]): AccessRole => ({ ...role, assignable: canAssign(role.id), holders: holdersOf(role.id), editable: editable(role), deletable: deletable(role) });

export function roles(): AccessRoleDirectory {
  return {
    roles: state.roles.map(served),
    permissions: [...PERMISSION_CATALOGUE],
    defaultRoleId: state.defaultRoleId,
  };
}

// A refusal answers as the API does: with its status and code, worded by the shared table.
function refuse(status: number, code: ApiErrorCode): never {
  throw new ApiError(status === 403 ? "forbidden" : "failed", API_ERROR_TEXT[code] ?? code, { status, code });
}

const ROLE_ID = /^[a-z][a-z0-9-]{0,31}$/;

function checkedDraft(draft: AccessRoleDraft): AccessRoleDraft {
  if (!callerHolds("access.manage")) refuse(403, "forbidden");
  if (draft.name.trim() === "" || new Set(draft.permissions).size !== draft.permissions.length) refuse(400, "invalid_role");
  for (const id of draft.permissions) {
    const entry = PERMISSION_CATALOGUE.find((item) => item.id === id);
    if (!entry) refuse(400, "invalid_role");
    if (entry.reserved) refuse(400, "reserved_permission");
  }
  return { name: draft.name.trim(), description: draft.description.trim(), permissions: [...draft.permissions] };
}

export function createRole(id: string, draft: AccessRoleDraft): AccessRole {
  const clean = checkedDraft(draft);
  if (!ROLE_ID.test(id)) refuse(400, "invalid_role");
  if (roleOf(id)) refuse(409, "role_exists");
  if (!holdsAll(clean.permissions)) refuse(403, "forbidden");
  const role = { id, ...clean, builtIn: false, protected: false, version: 1 };
  state.roles = [...state.roles, role];
  return served(role);
}

export function updateRole(roleId: string, draft: AccessRoleDraft, version: number): AccessRole {
  const role = roleOf(roleId);
  if (!role) refuse(400, "unknown_role");
  const clean = checkedDraft(draft);
  if (role.protected) refuse(409, "role_protected");
  if (role.version !== version) refuse(409, "role_changed");
  // Taking a permission away and putting one in both need the caller to hold it.
  const touched = [...role.permissions.filter((id) => !clean.permissions.includes(id)), ...clean.permissions.filter((id) => !role.permissions.includes(id))];
  if (!holdsAll(touched)) refuse(403, "forbidden");
  const saved = { ...role, ...clean, version: role.version + 1 };
  state.roles = state.roles.map((item) => (item.id === roleId ? saved : item));
  return served(saved);
}

export function deleteRole(roleId: string, version: number): void {
  const role = roleOf(roleId);
  if (!role) refuse(400, "unknown_role");
  if (!callerHolds("access.manage")) refuse(403, "forbidden");
  if (role.protected) refuse(409, "role_protected");
  if (role.builtIn) refuse(409, "role_built_in");
  if (role.version !== version) refuse(409, "role_changed");
  if (holdersOf(roleId) > 0 || roleId === state.defaultRoleId) refuse(409, "role_in_use");
  state.roles = state.roles.filter((item) => item.id !== roleId);
}

export function setDefaultRole(roleId: string): string {
  if (!callerHolds("access.manage")) refuse(403, "forbidden");
  const role = roleOf(roleId);
  if (!role) refuse(400, "unknown_role");
  if (role.protected) refuse(409, "role_protected");
  state.defaultRoleId = roleId;
  return roleId;
}

const sameAccount = (platform: string, platformUserId: string) => (item: { platform: string; platformUserId: string }) =>
  item.platform === platform && item.platformUserId === platformUserId;

export function approveCandidate(platform: string, platformUserId: string, chosen?: string): { id: string; displayName: string; roleId: string } {
  const roleId = chosen ?? state.defaultRoleId;
  const candidate = state.candidates.find(sameAccount(platform, platformUserId));
  if (!candidate) throw new Error("This account is no longer waiting for a decision.");
  if (!state.roles.some((role) => role.id === roleId)) throw new Error("This role no longer exists.");
  if (!canAssign(roleId)) throw new Error("Only an Owner can give or take the Owner role.");
  const identity: Mutable<Omit<AccessIdentity, "canDelete">> = {
    id: `identity-${platformUserId}`,
    displayName: candidate.displayName,
    photoUrl: candidate.photoUrl,
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
  if (identity.id === caller) throw new Error("You cannot change your own role.");
  if (!state.roles.some((role) => role.id === roleId)) throw new Error("This role no longer exists.");
  if (!canAssign(roleId) || !canAssign(identity.roleId)) throw new Error("Only an Owner can give or take the Owner role.");
  if (isProtected(identity.roleId) && !isProtected(roleId) && state.identities.filter((item) => isProtected(item.roleId)).length <= 1) throw new Error(identityDeletionRefusal(409, "last_owner"));
  identity.roleId = roleId;
}

// The demo signs in as identity-owner; only the access part changes.
export function deleteIdentity(identityId: string): void {
  if (identityId === caller) throw new Error(identityDeletionRefusal(409, "self_delete_forbidden"));
  const identity = state.identities.find((item) => item.id === identityId);
  if (!identity) return;
  if (isProtected(identity.roleId) && state.identities.filter((item) => isProtected(item.roleId)).length <= 1) throw new Error(identityDeletionRefusal(409, "last_owner"));
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

// The signed-in person's picture, kept as a data URL: the demo has no store to sign a link for.
// The stress fixture starts with one, so the gate sees the profile both ways.
const STRESS_AVATAR = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#5b47d6"/><circle cx="4" cy="3" r="1.6" fill="#fff"/><rect x="1.5" y="5" width="5" height="3" rx="1.5" fill="#fff"/></svg>')}`;
let avatarLink: string | null = demoFixture() === "stress" ? STRESS_AVATAR : null;
const AVATAR_MAX_BYTES = 256 * 1024;
const AVATAR_TYPES: readonly Readonly<{ type: string; starts: readonly (number | null)[] }>[] = [
  { type: "image/jpeg", starts: [0xff, 0xd8, 0xff] },
  { type: "image/png", starts: [0x89, 0x50, 0x4e, 0x47] },
  // RIFF, a four-byte size, then WEBP.
  { type: "image/webp", starts: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
];

function avatarRefusal(code: "invalid_avatar" | "avatar_too_large"): ApiError {
  return new ApiError("failed", API_ERROR_TEXT[code]!, { status: 400, code });
}

export function avatar(): string | null {
  return avatarLink;
}

/** Takes the base64 of an image as the API does: only JPEG, PNG or WebP, at most 256 KB. */
export function setAvatar(image: string): string {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(image), (character) => character.charCodeAt(0));
  } catch {
    throw avatarRefusal("invalid_avatar");
  }
  const found = AVATAR_TYPES.find((entry) => entry.starts.every((byte, index) => byte === null || bytes[index] === byte));
  if (!found) throw avatarRefusal("invalid_avatar");
  if (bytes.length > AVATAR_MAX_BYTES) throw avatarRefusal("avatar_too_large");
  avatarLink = `data:${found.type};base64,${image}`;
  return avatarLink;
}

export function clearAvatar(): void {
  avatarLink = null;
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
  const entry: ConsoleEntry = { id: `console-${state.counter + 100}`, at: iso(), identityId: "identity-owner", displayName: "DrArzter", agent: null, worldId, command: trimmed, status: "pending", output: null };
  state.console[key] = [entry, ...(state.console[key] ?? [])].slice(0, 30);
  window.setTimeout(() => {
    const list = state.console[key];
    const index = list?.findIndex((item) => item.id === entry.id) ?? -1;
    if (!list || index < 0) return;
    list[index] = { ...entry, status: "succeeded", output: demoReply(trimmed) };
  }, CONSOLE_REPLY_MS);
  return entry;
}

// `?operation=` (flag.ts) puts one promotion on the Creative world: running
// through its steps, held at one step, or ended at once with a long cause.
const PROMOTION_DEMO_MS = 27_000;
const HOLD_MS = 86_400_000;
const LONG_CAUSE = "We currently do not have sufficient m7i-flex.large capacity in the Availability Zone you requested (eu-central-1a). Our system will be working on provisioning additional capacity. You can currently get m7i-flex.large capacity by not specifying an Availability Zone in your request or choosing eu-central-1b, eu-central-1c.";

function seedOperation(): void {
  const kind = demoOperation();
  if (kind === null) return;
  const worldId = "minecraft-creative-5e1c9a07";
  const nothing = () => undefined;
  if (kind === "failed") {
    schedule("promote", worldId, 1200, nothing, {
      failure: { error: "Ec2.InsufficientInstanceCapacity", cause: LONG_CAUSE },
      caught: { error: "SessionStartFailed", cause: "The host did not report ready before the start timed out.", stepKey: "promote.starting_release" },
    });
  } else if (kind === "running") {
    schedule("promote", worldId, HOLD_MS, nothing, { durationMs: PROMOTION_DEMO_MS, pinAtMs: 20_000 });
  } else {
    schedule("promote", worldId, PROMOTION_DEMO_MS, nothing);
  }
}

seedOperation();
