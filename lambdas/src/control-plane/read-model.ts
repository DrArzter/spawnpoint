import type { LifecycleRecord } from "../domain/lifecycle.ts";
import { catalogWithPresets, gameCatalog, type CatalogGame } from "./catalog.ts";
import type { PresetObservation } from "./preset-catalog.ts";

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
  desiredRelease: string | null;
  activeRelease: string | null;
}>;

export type OperationObservation = Readonly<{
  id: string;
  type: "start" | "stop" | "promote";
  status: "running";
  startedAt: string;
  providerRef: string;
}>;

export type ControlPlaneSources = Readonly<{
  listHosts: () => Promise<readonly HostObservation[]>;
  readLifecycle: (serverId: string) => Promise<LifecycleRecord | null>;
  readReleasePointer: (worldId: string) => Promise<ReleasePointerObservation>;
  listRunningOperations: () => Promise<readonly OperationObservation[]>;
  listPresets?: () => Promise<readonly PresetObservation[]>;
}>;

export type ControlPlaneSnapshot = Readonly<{
  observedAt: string;
  games: ReadonlyArray<Readonly<{
    id: string;
    code: string;
    displayName: string;
    lifecycle: LifecycleRecord | null;
    worlds: ReadonlyArray<Readonly<{
      id: string;
      displayName: string;
      profileId: string;
      sessionControlAvailable: boolean;
      connectionAddress: string | null;
      connectivity: string;
      materialization: "existing" | "not_created";
      preset: CatalogGame["worlds"][number]["preset"] | null;
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
  const effectiveCatalog = catalogWithPresets(await (sources.listPresets?.() ?? Promise.resolve([])), catalog);
  const worldConnectionHost = (connectivity: string): string | null => {
    if (connectionHost === null) return null;
    if (connectivity !== "raw") return connectionHost;
    const running = hosts.find((host) => host.state === "running" && host.publicIp !== null);
    return running?.publicIp ?? null;
  };
  const worlds = effectiveCatalog.flatMap((game) => game.worlds);
  const [hosts, operations, lifecycles, pointers] = await Promise.all([
    sources.listHosts(),
    sources.listRunningOperations(),
    Promise.all(effectiveCatalog.map((game) => sources.readLifecycle(game.id))),
    Promise.all(worlds.map((world) => sources.readReleasePointer(world.id))),
  ]);
  const pointerByWorld = new Map(worlds.map((world, index) => [world.id, pointers[index]!]));

  return {
    observedAt: now().toISOString(),
    games: effectiveCatalog.map((game, gameIndex) => ({
      id: game.id,
      code: game.code,
      displayName: game.displayName,
      lifecycle: lifecycles[gameIndex] ?? null,
      worlds: game.worlds.map((world) => {
        const release = pointerByWorld.get(world.id) ?? { state: "unavailable" as const, desiredRelease: null, activeRelease: null };
        return {
          id: world.id,
          displayName: world.displayName,
          profileId: world.profileId,
          sessionControlAvailable: world.sessionControl !== null,
          connectivity: world.connectivity,
          materialization: world.materialization ?? "existing",
          preset: world.preset ?? null,
          // Composed here for the same reason the host composes it: the
          // strategy owns the host part, the game owns the port. An overlay
          // world uses the configured address; a public one uses whatever
          // address the instance holds right now, which is nothing at all while
          // it is stopped.
          connectionAddress: worldConnectionHost(world.connectivity) === null
            ? null
            : `${worldConnectionHost(world.connectivity)}:${game.connectPort}`,
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
