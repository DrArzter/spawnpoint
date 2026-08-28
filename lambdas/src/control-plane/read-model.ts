import type { LifecycleRecord } from "../domain/lifecycle.ts";
import { gameCatalog, type CatalogGame } from "./catalog.ts";

export type HostObservation = Readonly<{
  id: string;
  name: string;
  state: "pending" | "running" | "stopping" | "stopped" | "unknown";
  providerRef: string;
  instanceType: string | null;
  availabilityZone: string | null;
  launchedAt: string | null;
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
  options: Readonly<{ includeInfrastructure: boolean; includeDesiredRelease: boolean }>,
  catalog: readonly CatalogGame[] = gameCatalog,
  now: () => Date = () => new Date(),
): Promise<ControlPlaneSnapshot> {
  const worlds = catalog.flatMap((game) => game.worlds);
  const [hosts, operations, lifecycles, pointers] = await Promise.all([
    sources.listHosts(),
    sources.listRunningOperations(),
    Promise.all(catalog.map((game) => sources.readLifecycle(game.id))),
    Promise.all(worlds.map((world) => sources.readReleasePointer(world.id))),
  ]);
  const pointerByWorld = new Map(worlds.map((world, index) => [world.id, pointers[index]!]));

  return {
    observedAt: now().toISOString(),
    games: catalog.map((game, gameIndex) => ({
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
