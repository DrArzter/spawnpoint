import { awsControlPlaneSources } from "../../control-plane/aws.ts";
import { type Response, response, errorResponse } from "./http.ts";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// What one operation of a world is doing now, or how it ended. The operation
// id is the workflow's execution name; the execution's own input must name the
// world in the path, so an id cannot be used to read another world's run.
export async function operationProgress(gameId: string, worldId: string, operationId: string): Promise<Response> {
  if (!ID.test(gameId) || !ID.test(worldId) || !/^panel-[A-Za-z0-9-]{1,80}$/.test(operationId)) return errorResponse(400, "invalid_operation");
  const { readOperationProgress } = awsControlPlaneSources;
  if (readOperationProgress === undefined) return errorResponse(501, "operation_progress_unavailable");
  const progress = await readOperationProgress({ worldId, operationId });
  return progress === null ? errorResponse(404, "unknown_operation") : response(200, progress);
}
