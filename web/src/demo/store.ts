import type { AccessCandidate, AccessIdentity, AppearancePreference, BackupEntry, BackupInventory, InvitationRecipient, InvitationSummary, SubscriptionState } from "../auth";
import type { ConsoleEntry, FileLink, HostMetrics, MetricRange, ReleaseMods } from "../api/contract";
import { settingValueValid } from "../core/settings";
import type { ControlPlaneSnapshot, Preset, SettingValue, World, WorldGameSettings } from "../model";
import { DemoState, initialState, Mutable } from "./data";

// One in-memory control plane for the whole demo. Transitions are scheduled in
// time rather than run by timers, so any read settles whatever has come due —
// the console's own polling is what makes a start look like a start.
let state: DemoState = initialState();

const START_MS = 7000;
const STOP_MS = 6000;
const LIFECYCLE_MS = 6000;
const ARCHIVE_MS = 4000;
const DELIVERY_MS = 3000;

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

function schedule(type: "start" | "stop" | "world", afterMs: number, apply: (state: DemoState) => void): string {
  state.counter += 1;
  const id = `op-${type}-${state.counter.toString().padStart(4, "0")}`;
  state.snapshot.operations.push({ id, type, status: "running", startedAt: iso() });
  state.scheduled.push({ operationId: id, at: Date.now() + afterMs, apply });
  state.snapshot.observedAt = iso();
  return id;
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

function host() {
  return state.snapshot.hosts[0]!;
}

function requireIdle(): void {
  if (state.snapshot.operations.length > 0) throw new Error("Another control-plane operation is already running.");
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
  };
  const key = worldKey(gameId, target.id);
  state.backups[key] = [entry, ...(state.backups[key] ?? [])];
}

export function snapshot(): ControlPlaneSnapshot {
  settle();
  return state.snapshot;
}

export function startSession(gameId: string, worldId: string): { result: "requested"; operationId: string } {
  settle();
  requireIdle();
  const target = world(gameId, worldId);
  if (!target.sessionControlAvailable) throw new Error("This world is not connected to a session workflow yet.");
  const lifecycle = game(gameId).lifecycle;
  if (!lifecycle) throw new Error("This game has no session workflow.");
  const busy = state.snapshot.games.find((item) => item.lifecycle?.observedState !== "stopped");
  if (busy?.id === gameId && lifecycle.activeWorldId === worldId) throw new Error("This world is already running.");
  if (busy) throw new Error(`The shared host already runs ${busy.displayName}. Stop that session first.`);

  if (target.materialization === "not_created") {
    target.materialization = "existing";
    const release = target.preset?.latestRelease ?? target.release.desiredRelease ?? "1.0";
    const generationId = newGeneration(state.counter + 3);
    target.wipes = [{ id: generationId, number: 1, state: "current", createdAt: iso(), closedAt: null, originRelease: release }];
    target.release = { state: "available", generationId, activeRelease: release, desiredRelease: release };
  }

  lifecycle.desiredState = "running";
  lifecycle.observedState = "starting";
  lifecycle.activeSessionId = `session-${state.counter + 100}`;
  lifecycle.activeWorldId = worldId;
  lifecycle.updatedAtEpochSeconds = Math.floor(Date.now() / 1000);
  host().state = "pending";

  const operationId = schedule("start", START_MS, (current) => {
    const target = current.snapshot.games.find((item) => item.id === gameId)?.lifecycle;
    if (target) {
      target.observedState = "ready";
      target.updatedAtEpochSeconds = Math.floor(Date.now() / 1000);
    }
    const box = current.snapshot.hosts[0];
    if (box) {
      box.state = "running";
      box.launchedAt = iso();
    }
  });
  return { result: "requested", operationId };
}

export function stopSession(gameId: string, worldId: string): { result: "requested" | "already_stopped"; operationId?: string } {
  settle();
  const lifecycle = game(gameId).lifecycle;
  if (!lifecycle || lifecycle.observedState === "stopped") return { result: "already_stopped" };
  requireIdle();
  const target = world(gameId, worldId);
  lifecycle.observedState = "stopping";
  lifecycle.desiredState = "stopped";
  lifecycle.updatedAtEpochSeconds = Math.floor(Date.now() / 1000);
  host().state = "stopping";

  const operationId = schedule("stop", STOP_MS, (current) => {
    const next = current.snapshot.games.find((item) => item.id === gameId)?.lifecycle;
    if (next) {
      next.observedState = "stopped";
      next.activeSessionId = null;
      next.activeWorldId = null;
      next.updatedAtEpochSeconds = Math.floor(Date.now() / 1000);
    }
    const box = current.snapshot.hosts[0];
    if (box) {
      box.state = "stopped";
      box.launchedAt = null;
    }
    archive(gameId, target);
  });
  return { result: "requested", operationId };
}

export function worldLifecycle(gameId: string, worldId: string, action: "archive" | "regenerate" | "restore" | "purge", backupKey?: string, release?: string): { result: "requested"; operationId: string } {
  settle();
  requireIdle();
  const target = world(gameId, worldId);
  if (action === "purge" && target.materialization !== "archived") throw new Error("Archive this world before permanently deleting it.");
  if (action === "regenerate" && !(target.preset?.releases.includes(release ?? "") ?? false)) throw new Error("The selected release is no longer available. Refresh and try again.");
  if (action === "restore" && !(state.backups[worldKey(gameId, worldId)] ?? []).some((entry) => entry.key === backupKey)) throw new Error("This backup does not belong to the selected world.");

  const duration = action === "archive" || action === "purge" ? ARCHIVE_MS : LIFECYCLE_MS;
  const operationId = schedule("world", duration, (current) => {
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
      return;
    }
    if (action === "purge") {
      owner.worlds = owner.worlds.filter((item) => item.id !== worldId);
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
      origin = sourceWipe?.originRelease ?? next.release.activeRelease ?? "1.0";
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
  if (preset.buildStatus !== "ready") throw new Error("This preset has no ready release yet.");
  if (!preset.releases.includes(release)) throw new Error("The selected release is no longer available. Refresh and try again.");
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
    auth: auth ?? null,
    materialization: "existing",
    preset: { id: preset.id, repository: preset.repository, commit: preset.commit, profileDigest: preset.profileDigest, releases: [...preset.releases], buildStatus: preset.buildStatus, latestRelease: preset.latestRelease },
    wipes: [{ id: generationId, number: 1, state: "current", createdAt: iso(), closedAt: null, originRelease: release }],
    connectionAddress: connectivity === "zerotier" ? owner.worlds[0]?.connectionAddress ?? null : null,
    release: { state: "available", generationId, activeRelease: release, desiredRelease: release },
  });
  state.snapshot.observedAt = iso();
  return { id, displayName: displayName.trim() };
}

export function updateWorldSettings(gameId: string, worldId: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external"): void {
  settle();
  requireIdle();
  const owner = game(gameId);
  if (owner.lifecycle?.activeSessionId) throw new Error("Stop the world before changing its settings.");
  const target = world(gameId, worldId);
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

// A plausible evening: quiet, a session that starts, load while people play,
// then nothing — the gap is the point, because a stopped host reports nothing.
function hostMetrics(instanceId: string, range: MetricRange): HostMetrics {
  settle();
  const hours = range === "6h" ? 6 : range === "24h" ? 24 : 168;
  const period = hours <= 6 ? 300 : hours <= 48 ? 900 : 3600;
  const end = Date.now();
  const count = Math.floor((hours * 3600) / period);
  const series = [
    { id: "cpu", label: "CPU", unit: "percent", peak: 62 },
    { id: "networkIn", label: "Network in", unit: "bytes", peak: 4_800_000 },
    { id: "networkOut", label: "Network out", unit: "bytes", peak: 9_200_000 },
  ];
  return {
    range,
    startedAt: new Date(end - hours * 3_600_000).toISOString(),
    endedAt: new Date(end).toISOString(),
    periodSeconds: period,
    series: series.map((entry) => ({
      id: entry.id,
      label: entry.label,
      unit: entry.unit,
      points: Array.from({ length: count }, (_, index) => {
        const at = new Date(end - (count - index) * period * 1000).toISOString();
        const through = index / Math.max(count - 1, 1);
        // Stopped for the first third of the window: no host, no datapoints.
        if (through < 0.34) return { at, value: null };
        const ramp = Math.min(1, (through - 0.34) / 0.12);
        const wave = 0.55 + 0.45 * Math.sin(index / 3.7) * Math.cos(index / 11.3);
        return { at, value: Math.round(entry.peak * ramp * wave * 100) / 100 };
      }),
    })),
  };
}

// The demo runs every world on its one configured host. Like the API, it shows
// that host only for the world that holds the session: another world's load is
// not this one's.
export function worldMetrics(gameId: string, worldId: string, range: MetricRange): HostMetrics | null {
  settle();
  const lifecycle = state.snapshot.games.find((game) => game.id === gameId)?.lifecycle;
  const holds = lifecycle?.activeWorldId === worldId && lifecycle.observedState !== "stopped";
  return holds ? hostMetrics(state.snapshot.hosts[0]?.id ?? "host-game", range) : null;
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
  return { release, mods: files.map(([file, bytes]) => ({ file, bytes, sha256: demoDigest(file) })) };
}

export function modLink(gameId: string, presetId: string, release: string, sha256: string): FileLink {
  const mod = releaseMods(gameId, presetId, release).mods.find((candidate) => candidate.sha256 === sha256);
  if (!mod) throw new Error("This release no longer lists that mod.");
  return { url: demoFile("Spawnpoint demo mod", [`File:    ${mod.file}`, `Release: ${presetId} ${release}`], "the mod's jar"), expiresIn: 900 };
}

export function backupLink(gameId: string, worldId: string, key: string): FileLink {
  settle();
  const entry = (state.backups[worldKey(gameId, worldId)] ?? []).find((candidate) => candidate.key === key);
  if (!entry) throw new Error("This backup is no longer in the store. Refresh the list.");
  return { url: demoFile("Spawnpoint demo world backup", [`World:   ${world(gameId, worldId).displayName}`, `Archive: ${entry.archiveName}`], "the world archive"), expiresIn: 300 };
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
  if (game.lifecycle?.activeWorldId !== worldId || game.lifecycle.observedState !== "ready") throw new Error("This world is not running. Start it first.");
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
