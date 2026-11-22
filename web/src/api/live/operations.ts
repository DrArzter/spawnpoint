import { apiFailure, type OperationProgress, type SpawnpointApi } from "../contract";
import { authorizedFetch } from "./transport";

export const operationsApi = {
  async loadOperationProgress(gameId: string, worldId: string, operationId: string): Promise<OperationProgress | null> {
    const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/operations/${encodeURIComponent(operationId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await apiFailure(response, response.status === 403 ? "Your role cannot read operations." : "The operation could not be read.");
    return await response.json() as OperationProgress;
  },
} satisfies Partial<SpawnpointApi>;
