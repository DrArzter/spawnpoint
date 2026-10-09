import type { LifecycleRecord } from "../domain/lifecycle.ts";
import { catalogWithPresets, gameCatalog, type CatalogGame, worldAddress } from "./catalog.ts";
import { locateWorldSession, sessionLifecycleKey } from "./world-session.ts";
import type { PresetObservation } from "./preset-catalog.ts";
import type { WorldRecord } from "./world-registry.ts";
import { gameSettingDefinitions, type SettingDefinition, type SettingValue } from "./game-settings.ts";

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
  /** The persistent Terraform host remains the workflow's fallback reference. */
  provenance?: "configured" | "launched";
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
  /** The world the workflow's input names; null when it names none (ADR-0062). */
  worldId: string | null;
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
    /** What a world of this game may set (ADR-0064); empty when the game defines nothing. */
    settings: readonly SettingDefinition[];
    /** The game keeps a whitelist a world's record can hold (ADR-0066). */
    whitelist: boolean;
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
      placement: "configured" | "fleet";
      auth: "game" | "external" | null;
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
      /** This world's session, wherever it lives (ADR-0062); null when it has none. */
      session: WorldSessionView | null;
      /** The game settings this world sets; null when it has no record to keep them in. */
      gameSettings: Readonly<{ values: Readonly<Record<string, SettingValue>>; updatedAt: string | null }> | null;
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
    worldId: string | null;
    providerRef?: string;
  }>>;
}>;

/** What a viewer may know of a world's session: never the lease or the fence. */
export type WorldSessionView = Readonly<{
  serverId: string;
  desiredState: LifecycleRecord["desiredState"];
  observedState: LifecycleRecord["observedState"];
  activeSessionId: string | null;
  activeWorldId: string | null;
  idle: LifecycleRecord["idle"];
  updatedAtEpochSeconds: number;
}>;

function sessionView(serverId: string, record: LifecycleRecord | null): WorldSessionView | null {
  if (record === null) return null;
  return {
    serverId,
    desiredState: record.desiredState,
    observedState: record.observedState,
    activeSessionId: record.activeSessionId,
    activeWorldId: record.activeWorldId ?? null,
    idle: record.idle,
    updatedAtEpochSeconds: record.updatedAtEpochSeconds,
  };
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
  // running instance holds right now, and nothing between sessions.
  const hostPublicIp = hosts.find((host) => host.state === "running" && host.publicIp !== null)?.publicIp ?? null;
  const pointerByWorld = new Map(worlds.map((world, index) => [world.id, pointers[index]!]));
  const ownRecordByWorld = new Map(fleetWorlds.map(({ world }, index) => [world.id, ownRecords[index] ?? null]));

  return {
    observedAt: (observedAt ?? now()).toISOString(),
    games: effectiveCatalog.map((game, gameIndex) => ({
      id: game.id,
      code: game.code,
      displayName: game.displayName,
      lifecycle: lifecycles[gameIndex] ?? null,
      settings: gameSettingDefinitions(game.id),
      whitelist: game.whitelist === true,
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
        const session = locateWorldSession(game.id, world.id, world.placement ?? "configured", {
          game: lifecycles[gameIndex] ?? null,
          own: ownRecordByWorld.get(world.id) ?? null,
        });
        const release = pointerByWorld.get(world.id) ?? { state: "unavailable" as const, generationId: null, desiredRelease: null, activeRelease: null };
        const record = recordByWorld.get(world.id);
        const generations = record === undefined ? [] : [...record.previousGenerations, record.currentGeneration];
        return {
          id: world.id,
          displayName: world.displayName,
          profileId: world.profileId,
          sessionControlAvailable: world.sessionControl !== null,
          connectivity: world.connectivity,
          placement: world.placement ?? "configured",
          auth: record?.auth ?? null,
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
            : observedAddress(session.record, world.id)
              ?? (world.placement === "fleet" ? null : worldAddress(world.id, { connectionHost, publicIp: hostPublicIp }, effectiveCatalog)),
          release: options.includeDesiredRelease ? release : { ...release, desiredRelease: null },
          session: sessionView(session.serverId, session.record),
          gameSettings: record === undefined ? null : { values: record.gameSettings?.values ?? {}, updatedAt: record.gameSettings?.updatedAt ?? null },
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
        launchedAt: host.launchedAt,
      } : {}),
    })),
    operations: operations.map((operation) => ({
      id: operation.id,
      type: operation.type,
      status: operation.status,
      startedAt: operation.startedAt,
      worldId: operation.worldId,
      ...(options.includeInfrastructure ? { providerRef: operation.providerRef } : {}),
    })),
  };
}
