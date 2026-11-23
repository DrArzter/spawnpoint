import type { OperationProgress, SpawnpointApi } from "../contract";
import { requestOrNull } from "./request";

export const operationsApi = {
  loadOperationProgress(gameId: string, worldId: string, operationId: string): Promise<OperationProgress | null> {
    return requestOrNull<OperationProgress>(
      `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/operations/${encodeURIComponent(operationId)}`,
      { failure: "The operation could not be read.", refusals: { forbidden: "Your role cannot read operations." } },
      (error) => error.status === 404,
    );
  },
} satisfies Partial<SpawnpointApi>;
