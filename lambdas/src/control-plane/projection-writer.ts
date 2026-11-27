import { executionChange, withExecutionChange, type ControlPlaneEvent } from "./dynamic-projection.ts";
import type { HostObservation, OperationObservation } from "./read-model.ts";

export type StoredProjection = Readonly<{
  sourceEventId: string;
  observedAtEpochMilliseconds: number;
  hosts: readonly HostObservation[];
  operations: readonly OperationObservation[];
}>;

export type ProjectionWriterPorts = Readonly<{
  listHosts: () => Promise<readonly HostObservation[]>;
  listRunningOperations: () => Promise<readonly OperationObservation[]>;
  describeRunningOperation: (executionArn: string) => Promise<OperationObservation | null>;
  /** Stores the projection unless a newer one is stored; false when refused. */
  putProjection: (projection: StoredProjection) => Promise<boolean>;
  now: () => number;
}>;

export type ProjectionWrite = StoredProjection & Readonly<{ written: boolean }>;

/**
 * Reads the hosts and operations and stores them as the projection. The time
 * is taken just before the reads, so a later time means fresher reads. A
 * refused write means another event stored a newer projection meanwhile; that
 * one may not carry this event's change, so it reads and writes again.
 */
export async function writeProjection(ports: ProjectionWriterPorts, event: ControlPlaneEvent, attempts = 3): Promise<ProjectionWrite> {
  const change = executionChange(event);
  let result: ProjectionWrite | null = null;
  for (let attempt = 0; attempt < attempts && result?.written !== true; attempt += 1) {
    const observedAtEpochMilliseconds = ports.now();
    const [hosts, listed] = await Promise.all([ports.listHosts(), ports.listRunningOperations()]);
    const operations = await withExecutionChange(listed, change, ports.describeRunningOperation);
    const projection = { sourceEventId: event.id, observedAtEpochMilliseconds, hosts, operations };
    result = { ...projection, written: await ports.putProjection(projection) };
  }
  return result!;
}
