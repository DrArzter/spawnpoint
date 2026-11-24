import { awsConsoleGateway } from "../../control-plane/aws-ssm-console-gateway.ts";
import { awsWorldRecords } from "../../control-plane/aws-world-records.ts";
import { awsWorldLogRecords } from "./world-log-store.ts";
import { worldLogFeature } from "./world-log.ts";
import { readyWorldSession, worldCatalog } from "./world-state.ts";

// A world's log as deployed: its ports bound to the AWS adapters.
export const deployedWorldLog = worldLogFeature({
  catalog: worldCatalog,
  session: readyWorldSession,
  gateway: awsConsoleGateway,
  records: awsWorldLogRecords,
  knownNames: async (gameId, worldId) => {
    const record = await awsWorldRecords.read(worldId);
    return record?.gameId === gameId ? record.whitelist?.names ?? [] : [];
  },
  now: () => new Date(),
});
