import type { LifecycleRecord } from "../domain/lifecycle.ts";
import { catalogWithPresets, gameCatalog, type CatalogGame, worldAddress } from "./catalog.ts";
import type { PresetObservation } from "./preset-catalog.ts";
import type { WorldRecord } from "./world-registry.ts";

export type HostObservation = Readonly<{
  id: string;
  name: string;
  state: "pending" | "running" | "stopping" | "stopped" | "unknown";
  providerRef: string;
  instanceType: string | null;
  availabilityZone: string | null;
  launchedAt: string | null;
  // Ephemeral by design: a stopped host has none, and a started one usually has
  // a different address than last time. Which is why nothing stores it.
  publicIp: string | null;
}>;

export type ReleasePointerObservation = Readonly<{
  state: "available" | "unconfigured" | "unavailable";
  generationId: string | null;
  desiredRelease: string | null;
  activeRelease: string | null;
}>;

export type OperationObservation = Readonly<{
  id: string;
  type: "start" | "stop" | "promote" | "world";
  status: "running";
  startedAt: string;
  providerRef: string;
}>;

export type HostMetricPoint = Readonly<{ at: string; value: number | null }>;
export type HostMetricSeries = Readonly<{ id: string; label: string; unit: string; points: readonly HostMetricPoint[] }>;
export type HostMetrics = Readonly<{ startedAt: string; endedAt: string; periodSeconds: number; series: readonly HostMetricSeries[] }>;

export type ControlPlaneSources = Readonly<{
  readObservedAt?: () => Promise<Date | null>;
  listHosts: () => Promise<readonly HostObservation[]>;
  readLifecycle: (serverId: string) => Promise<LifecycleRecord | null>;
  readReleasePointer: (worldId: string, generationId: string | null) => Promise<ReleasePointerObservation>;
  listRunningOperations: () => Promise<readonly OperationObservation[]>;
  listPresets?: () => Promise<readonly PresetObservation[]>;
  readReleaseManifest?: (gameId: string, presetId: string, version: string) => Promise<unknown | null>;
  readHostMetrics?: (instanceId: string, hours: number) => Promise<HostMetrics>;
  listWorldRecords?: () => Promise<readonly WorldRecord[]>;
}>;

export type ControlPlaneSnapshot = Readonly<{
  observedAt: string;
  games: ReadonlyArray<Readonly<{
    id: string;
    code: string;
    displayName: string;
    lifecycle: LifecycleRecord | null;
    presets: ReadonlyArray<Readonly<{
      id: string;
      displayName: string;
      repository: string;
      commit: string;
      profileDigest: string;
      releases: readonly string[];
      buildStatus: "unbuilt" | "building" | "ready" | "failed";
      latestRelease: string | null;
    }>>;
    worlds: ReadonlyArray<Readonly<{
      id: string;
      displayName: string;
      profileId: string;
      sessionControlAvailable: boolean;
      connectionAddress: string | null;
      connectivity: string;
      materialization: "existing" | "not_created" | "archived";
      worldLifecycleAvailable: boolean;
      preset: CatalogGame["worlds"][number]["preset"] | null;
      wipes: ReadonlyArray<Readonly<{
        id: string;
        number: number;
        state: "current" | "closed";
        createdAt: string;
        closedAt: string | null;
        originRelease: string;
      }>>;
      release: ReleasePointerObservation;
    }>>;
  }>>;
  hosts: ReadonlyArray<Readonly<{
    id: string;
    name: string;
    state: HostObservation["state"];
    providerRef?: string;
    instanceType?: string | null;
    availabilityZone?: string | null;
    launchedAt?: string | null;
  }>>;
  operations: ReadonlyArray<Readonly<{
    id: string;
    type: OperationObservation["type"];
    status: "running";
    startedAt: string;
    providerRef?: string;
  }>>;
}>;

function observedAddress(lifecycle: LifecycleRecord | null, worldId: string): string | null {
  if (lifecycle === null || lifecycle.activeWorldId !== worldId || lifecycle.observedState !== "ready") return null;
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
  }>,
  catalog: readonly CatalogGame[] = gameCatalog,
  now: () => Date = () => new Date(),
): Promise<ControlPlaneSnapshot> {
  const connectionHost = options.connectionHost ?? null;
  const [presets, worldRecords] = await Promise.all([
    sources.listPresets?.() ?? Promise.resolve([]),
    sources.listWorldRecords?.() ?? Promise.resolve([]),
  ]);
  const effectiveCatalog = catalogWithPresets(presets, catalog, worldRecords);
  const recordByWorld = new Map(worldRecords.map((record) => [record.worldId, record]));
  const worlds = effectiveCatalog.flatMap((game) => game.worlds);
  const [observedAt, hosts, operations, lifecycles, pointers] = await Promise.all([
    sources.readObservedAt?.() ?? Promise.resolve(null),
    sources.listHosts(),
    sources.listRunningOperations(),
    Promise.all(effectiveCatalog.map((game) => sources.readLifecycle(game.id))),
    Promise.all(worlds.map((world) => sources.readReleasePointer(
      world.id,
      recordByWorld.get(world.id)?.currentGeneration.id ?? null,
    ))),
  ]);
  // Ephemeral by design: the address a public world publishes is whatever the
  // running instance holds right now, and nothing between sessions.
  const hostPublicIp = hosts.find((host) => host.state === "running" && host.publicIp !== null)?.publicIp ?? null;
  const pointerByWorld = new Map(worlds.map((world, index) => [world.id, pointers[index]!]));

  return {
    observedAt: (observedAt ?? now()).toISOString(),
    games: effectiveCatalog.map((game, gameIndex) => ({
      id: game.id,
      code: game.code,
      displayName: game.displayName,
      lifecycle: lifecycles[gameIndex] ?? null,
      presets: (game.presets ?? []).map((preset) => ({
        id: preset.id,
        displayName: preset.displayName,
        repository: preset.repository,
        commit: preset.commit,
        profileDigest: preset.profileDigest,
        releases: preset.releases,
        buildStatus: preset.buildStatus,
        latestRelease: preset.latestRelease,
      })),
      worlds: game.worlds.map((world) => {
        const release = pointerByWorld.get(world.id) ?? { state: "unavailable" as const, generationId: null, desiredRelease: null, activeRelease: null };
        const record = recordByWorld.get(world.id);
        const generations = record === undefined ? [] : [...record.previousGenerations, record.currentGeneration];
        return {
          id: world.id,
          displayName: world.displayName,
          profileId: world.profileId,
          sessionControlAvailable: world.sessionControl !== null,
          connectivity: world.connectivity,
          materialization: world.materialization ?? "existing",
          worldLifecycleAvailable: world.worldLifecycle !== null && world.worldLifecycle !== undefined,
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
          // The address the host reported when this world's session became
          // ready is the truth: it carries the session's slot and the host it
          // landed on (ADR-0054). Composed only while nothing is observed — the
          // strategy's host part plus the game's own port — and withheld
          // altogether from a caller who may not read one.
          connectionAddress: connectionHost === null
            ? null
            : observedAddress(lifecycles[gameIndex] ?? null, world.id) ?? worldAddress(world.id, { connectionHost, publicIp: hostPublicIp }, effectiveCatalog),
          release: options.includeDesiredRelease ? release : { ...release, desiredRelease: null },
        };
      }),
    })),
    hosts: hosts.map((host) => ({
      id: host.id,
      name: host.name,
      state: host.state,
      ...(options.includeInfrastructure ? {
        providerRef: host.providerRef,
        instanceType: host.instanceType,
        availabilityZone: host.availabilityZone,
        launchedAt: host.launchedAt,
      } : {}),
    })),
    operations: operations.map((operation) => ({
      id: operation.id,
      type: operation.type,
      status: operation.status,
      startedAt: operation.startedAt,
      ...(options.includeInfrastructure ? { providerRef: operation.providerRef } : {}),
    })),
  };
}
