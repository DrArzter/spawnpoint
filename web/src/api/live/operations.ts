import type { OperationProgress, SpawnpointApi } from "../contract";
import { requestOrNull } from "./request";
import { t } from "../../i18n";

export const operationsApi = {
  loadOperationProgress(gameId: string, worldId: string, operationId: string): Promise<OperationProgress | null> {
    return requestOrNull<OperationProgress>(
      `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/operations/${encodeURIComponent(operationId)}`,
      { failure: t("world.operationCouldNotRead"), refusals: { forbidden: t("world.roleCannotReadOperations") } },
      (error) => error.status === 404,
    );
  },
} satisfies Partial<SpawnpointApi>;
