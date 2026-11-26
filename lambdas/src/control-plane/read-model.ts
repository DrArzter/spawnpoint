import { PLAYER_READING_FRESH_SECONDS } from "../domain/watchdog-timing.ts";
import type { LifecycleRecord } from "../domain/lifecycle.ts";
import type { ReleaseStateReader } from "./release-usable.ts";
import type { OperationProgress } from "./operation-progress.ts";
import type { SessionHost } from "../domain/session-history.ts";
import { catalogWithPresets, displayAddress, gameCatalog, type CatalogGame, worldAddress } from "./catalog.ts";
import { locateWorldSession, sessionLifecycleKey } from "./world-session.ts";
import type { PresetObservation } from "./preset-catalog.ts";
import type { WorldRecord } from "./world-registry.ts";
import { gameSettingDefinitions } from "./game-settings.ts";
import type { HostMetricPoint, HostMetrics, HostMetricSeries } from "../../../contract/metrics.ts";
import type { ControlPlaneSnapshot, HostState, OperationType, ReleasePointer, WorldSession } from "../../../contract/control-plane.ts";

export type { HostMetricPoint, HostMetricSeries };

export type HostObservation = Readonly<{
  id: string;
  name: string;
  state: HostState;
  providerRef: string;
  instanceType: string | null;
  availabilityZone: string | null;
  market?: "spot" | "on-demand" | null;
  launchedAt: string | null;
  // Ephemeral by design: a stopped host has none, and a started one usually has
  // a different address than last time. Which is why nothing stores it.
  publicIp: string | null;
  /** The persistent Terraform host remains the workflow's fallback reference. */
  provenance?: "configured" | "launched";
}>;

/** A wipe's release pointer as the API sends it (contract/control-plane.ts). */
export type ReleasePointerObservation = ReleasePointer;

export type OperationObservation = Readonly<{
  id: string;
  type: OperationType;
  status: "running";
  startedAt: string;
  providerRef: string;
  /** The world the workflow's input names; null when it names none (ADR-0062). */
  worldId: string | null;
  /** The usual duration of this type for this world; absent with too little history. */
  expectedSeconds?: number;
  expectedSamples?: number;
}>;

/** A host's metrics over a window; the handler adds the range it was asked for (contract/metrics.ts). */
export type HostMetricsWindow = Omit<HostMetrics, "range">;

export type ControlPlaneSources = Readonly<{
  readObservedAt?: () => Promise<Date | null>;
  listHosts: () => Promise<readonly HostObservation[]>;
  readLifecycle: (serverId: string) => Promise<LifecycleRecord | null>;
  readReleasePointer: (worldId: string, generationId: string | null) => Promise<ReleasePointerObservation>;
  /** Whether any backup archive of this wipe exists. Absent on a control plane that cannot list them. */
  hasGenerationBackup?: (worldId: string, generationId: string) => Promise<boolean>;
  listRunningOperations: () => Promise<readonly OperationObservation[]>;
  /** What one operation of a world is doing now; null when it is not that world's or not there. */
  readOperationProgress?: (request: Readonly<{ worldId: string; operationId: string }>) => Promise<OperationProgress | null>;
  listPresets?: () => Promise<readonly PresetObservation[]>;
  readReleaseManifest?: (gameId: string, presetId: string, version: string) => Promise<unknown>;
  /** The release's state in the reference table (ADR-0080); null when the table has no item for it. */
  readReleaseState?: ReleaseStateReader;
  /** The build's plan.json beside the manifest; null when the release has none. */
  readReleasePlan?: (gameId: string, presetId: string, version: string) => Promise<unknown>;
  readHostMetrics?: (instanceId: string, hours: number) => Promise<HostMetricsWindow>;
  /** The same window for several hosts at once, by host id. */
  readHostsMetrics?: (hostIds: readonly string[], hours: number) => Promise<Readonly<Record<string, HostMetricsWindow>>>;
  /** The hosts a world's sessions ran on since a time, from the stored history and, before it, the workflows. */
  readWorldSessionHosts?: (worldId: string, sinceMs: number) => Promise<readonly SessionHost[]>;
  listWorldRecords?: () => Promise<readonly WorldRecord[]>;
  /** Which host and slot a session holds (ADR-0054); null when no host reserves it. */
  findSessionPlacement?: (sessionId: string) => Promise<Readonly<{ hostId: string; slot: number }> | null>;
}>;

/** The snapshot as the read model builds it; the handler adds the deployment (contract/control-plane.ts). */
export type ControlPlaneObservation = Omit<ControlPlaneSnapshot, "deployment">;

/** What a viewer may know of a world's session: never the lease or the fence (contract/control-plane.ts). */
export type WorldSessionView = WorldSession;

function sessionView(serverId: string, record: LifecycleRecord | null): WorldSessionView | null {
  if (record === null) return null;
  return {
    serverId,
    desiredState: record.desiredState,
    observedState: record.observedState,
    activeSessionId: record.activeSessionId,
    activeWorldId: record.activeWorldId ?? null,
    // Named field by field: the watchdog's execution and command ids are its own.
    idle: record.idle === null ? null : {
      playersOnline: record.idle.playersOnline,
      consecutiveEmpty: record.idle.consecutiveEmpty,
      lastObservedAtEpochSeconds: record.idle.lastObservedAtEpochSeconds,
      freshUntilEpochSeconds: record.idle.lastObservedAtEpochSeconds === null ? null : record.idle.lastObservedAtEpochSeconds + PLAYER_READING_FRESH_SECONDS,
    },
    readyAtEpochSeconds: record.readyAtEpochSeconds ?? null,
    updatedAtEpochSeconds: record.updatedAtEpochSeconds,
  };
}

// A route53 world's record is always <world id>.<suffix> (server/connectivity/route53.sh), so its name is known while
// it is stopped; a session on another port than the game's own reports its full address while it runs.
function dnsAddress(world: Readonly<{ id: string; connectivity: string }>, suffix: string | null): string | null {
  return world.connectivity === "route53" && suffix !== null && suffix !== "" ? `${world.id}.${suffix}` : null;
}

function observedAddress(lifecycle: LifecycleRecord | null, worldId: string): string | null {
  if (lifecycle?.activeWorldId !== worldId || lifecycle?.observedState !== "ready") return null;
  return lifecycle.activeSessionAddress ?? null;
}

export async function readControlPlaneSnapshot(
  sources: ControlPlaneSources,
  options: Readonly<{
    includeInfrastructure: boolean;
    includeDesiredRelease: boolean;
    // The connectivity strategy's answer for this deployment. Null when the
    // caller may not see an address at all, which is the visitor's case.
    connectionHost?: string | null;
    // The DNS suffix of route53 worlds; their name is fixed, so it is shown while they are stopped too.
    dnsSuffix?: string | null;
  }>,
  catalog: readonly CatalogGame[] = gameCatalog,
  now: () => Date = () => new Date(),
): Promise<ControlPlaneObservation> {
  const connectionHost = options.connectionHost ?? null;
  const [presets, worldRecords] = await Promise.all([
    sources.listPresets?.() ?? Promise.resolve([]),
    sources.listWorldRecords?.() ?? Promise.resolve([]),
  ]);
  const effectiveCatalog = catalogWithPresets(presets, catalog, worldRecords);
  const recordByWorld = new Map(worldRecords.map((record) => [record.worldId, record]));
  const worlds = effectiveCatalog.flatMap((game) => game.worlds);
  // A fleet world keeps its sessions on a record of its own (ADR-0062).
  const fleetWorlds = effectiveCatalog.flatMap((game) => game.worlds.filter((world) => world.placement === "fleet").map((world) => ({ game, world })));
  const [observedAt, hosts, operations, lifecycles, ownRecords, pointers] = await Promise.all([
    sources.readObservedAt?.() ?? Promise.resolve(null),
    sources.listHosts(),
    sources.listRunningOperations(),
    Promise.all(effectiveCatalog.map((game) => sources.readLifecycle(game.id))),
    Promise.all(fleetWorlds.map(({ game, world }) => sources.readLifecycle(sessionLifecycleKey(game.id, world.id, "fleet")))),
    Promise.all(worlds.map((world) => sources.readReleasePointer(
      world.id,
      recordByWorld.get(world.id)?.currentGeneration.id ?? null,
    ))),
  ]);
  // Ephemeral by design: the address a public world publishes is whatever the
  // running instance holds right now, and nothing between sessions. Only the
  // configured host's: a launched host holds fleet sessions, not this world.
  const hostPublicIp = hosts.find((host) => host.provenance !== "launched" && host.state === "running" && host.publicIp !== null)?.publicIp ?? null;
  const pointerByWorld = new Map(worlds.map((world, index) => [world.id, pointers[index]!]));
  const ownRecordByWorld = new Map(fleetWorlds.map(({ world }, index) => [world.id, ownRecords[index] ?? null]));

  return {
    observedAt: (observedAt ?? now()).toISOString(),
    games: effectiveCatalog.map((game, gameIndex) => ({
      id: game.id,
      code: game.code,
      displayName: game.displayName,
      lifecycle: sessionView(lifecycles[gameIndex]?.serverId ?? game.id, lifecycles[gameIndex] ?? null),
      settings: gameSettingDefinitions(game.id),
      whitelist: game.whitelist === true,
      playerName: game.playerName ?? null,
      consoleSuggestions: game.consoleSuggestions ?? [],
      presets: (game.presets ?? []).map((preset) => ({
        id: preset.id,
        displayName: preset.displayName,
        repository: preset.repository,
        commit: preset.commit,
        profileDigest: preset.profileDigest,
        releases: preset.releases,
        buildStatus: preset.buildStatus,
        latestRelease: preset.latestRelease,
        ...(preset.olderReleases?.length ? { olderReleases: preset.olderReleases } : {}),
        ...(preset.buildAvailable === undefined ? {} : { buildAvailable: preset.buildAvailable }),
        ...(preset.build === undefined ? {} : { build: preset.build }),
      })),
      worlds: game.worlds.map((world) => {
        const session = locateWorldSession(game.id, world.id, world.placement ?? "configured", {
          game: lifecycles[gameIndex] ?? null,
          own: ownRecordByWorld.get(world.id) ?? null,
        });
        const release = pointerByWorld.get(world.id) ?? { state: "unavailable" as const, generationId: null, desiredRelease: null, activeRelease: null };
        const record = recordByWorld.get(world.id);
        const generations = record === undefined ? [] : [...record.previousGenerations, record.currentGeneration];
        // The address the host reported when this world's session became
        // ready is the truth: it carries the session's slot and the host it
        // landed on (ADR-0054). Composed only while nothing is observed — the
        // strategy's host part plus the game's own port — and withheld
        // altogether from a caller who may not read one.
        let connectionAddress: string | null = null;
        if (connectionHost !== null) {
          const address = observedAddress(session.record, world.id)
            ?? dnsAddress(world, options.dnsSuffix ?? null)
            ?? (world.placement === "fleet" ? null : worldAddress(world.id, { connectionHost, publicIp: hostPublicIp }, effectiveCatalog));
          connectionAddress = address === null ? null : displayAddress(address, world.id, effectiveCatalog);
        }
        return {
          id: world.id,
          displayName: world.displayName,
          profileId: world.profileId,
          sessionControlAvailable: world.sessionControl !== null,
          connectivity: world.connectivity,
          placement: world.placement ?? "configured",
          auth: record?.auth ?? null,
          materialization: world.materialization ?? "existing",
          preset: world.preset ?? null,
          wipes: generations.map((generation, index) => ({
            id: generation.id,
            number: index + 1,
            state: index === generations.length - 1 ? "current" as const : "closed" as const,
            createdAt: generation.createdAt,
            closedAt: "closedAt" in generation && typeof generation.closedAt === "string"
              ? generation.closedAt
              : null,
            originRelease: generation.release,
          })),
          connectionAddress,
          release: options.includeDesiredRelease ? release : { ...release, desiredRelease: null },
          session: sessionView(session.serverId, session.record),
          gameSettings: { values: record?.gameSettings?.values ?? {}, updatedAt: record?.gameSettings?.updatedAt ?? null },
        };
      }),
    })),
    hosts: hosts.map((host) => ({
      id: host.id,
      name: host.name,
      state: host.state,
      provenance: host.provenance ?? "configured",
      ...(options.includeInfrastructure ? {
        providerRef: host.providerRef,
        instanceType: host.instanceType,
        availabilityZone: host.availabilityZone,
        market: host.market ?? null,
        launchedAt: host.launchedAt,
      } : {}),
    })),
    operations: operations.map((operation) => ({
      id: operation.id,
      type: operation.type,
      status: operation.status,
      startedAt: operation.startedAt,
      worldId: operation.worldId,
      ...(operation.expectedSeconds === undefined ? {} : { expectedSeconds: operation.expectedSeconds, expectedSamples: operation.expectedSamples }),
      ...(options.includeInfrastructure ? { providerRef: operation.providerRef } : {}),
    })),
  };
}
