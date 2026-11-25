import { randomUUID } from "node:crypto";

import { type Identity } from "../../access/domain.ts";
import { hostDeletionRefusal, PERSISTENT_HOST_NAME, type HostDeletion } from "../../control-plane/host-deletion.ts";
import { type ControlPlaneSources } from "../../control-plane/read-model.ts";
import { errorResponse, parseJsonObject, response, type Response } from "./http.ts";

/** What deleting a host needs, injected so that it depends on no cloud API. */
export type HostsDependencies = Readonly<{
  sources: ControlPlaneSources;
  deletion: HostDeletion;
}>;

const INSTANCE_ID = /^i-[0-9a-f]{8,32}$/;

export function hostsFeature({ sources, deletion }: HostsDependencies) {
  // Delete a persistent host once every world has left it (ADR-0100). The
  // owner chooses, each time, whether its data volumes are kept as snapshots.
  async function deleteHost(identity: Identity, hostId: string, body: string | undefined): Promise<Response> {
    if (!INSTANCE_ID.test(hostId)) return errorResponse(400, "invalid_instance_id");
    const parsed = parseJsonObject({ body });
    if (typeof parsed.snapshot !== "boolean") return errorResponse(400, "invalid_snapshot_choice");
    const [hosts, worlds, operations] = await Promise.all([
      sources.listHosts(),
      sources.listWorldRecords?.() ?? Promise.resolve([]),
      sources.listRunningOperations(),
    ]);
    const refusal = hostDeletionRefusal(hostId, hosts, worlds, operations);
    if (refusal !== null) return errorResponse(refusal === "unknown_host" ? 404 : 409, refusal);
    const disks = await deletion.readDisks(hostId);
    if (disks === null) return errorResponse(404, "unknown_host");
    if (disks.name !== PERSISTENT_HOST_NAME) return errorResponse(409, "not_a_spawnpoint_host");
    const operationId = `panel-delete-host-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
    await deletion.start({ operationId, requestedBy: `identity:${identity.id}`, hostId, dataVolumeIds: disks.dataVolumeIds, snapshot: parsed.snapshot });
    return response(202, { result: "requested", operationId, dataVolumes: disks.dataVolumeIds.length, snapshot: parsed.snapshot });
  }

  return { deleteHost };
}
