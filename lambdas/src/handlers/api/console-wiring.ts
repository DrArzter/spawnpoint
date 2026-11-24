import { awsControlPlaneSources } from "../../control-plane/aws.ts";
import { awsConsoleGateway } from "../../control-plane/aws-ssm-console-gateway.ts";
import { catalogWithPresets, gameCatalog } from "../../control-plane/catalog.ts";
import { awsConsoleRecords } from "./console-store.ts";
import { consoleFeature, type ConsoleSession } from "./console.ts";
import { locateWorldHost, readWorldSession } from "./world-state.ts";

// The console as deployed: its ports bound to the AWS adapters. The routes
// and MCP use this; a test builds the feature with fakes instead.
export const deployedConsole = consoleFeature({
  catalog: async () => {
    const [presets, worldRecords] = await Promise.all([
      awsControlPlaneSources.listPresets?.() ?? Promise.resolve([]),
      awsControlPlaneSources.listWorldRecords?.() ?? Promise.resolve([]),
    ]);
    return catalogWithPresets(presets, gameCatalog, worldRecords);
  },
  session: async (gameId, worldId, placement): Promise<ConsoleSession> => {
    const [located, hosts] = await Promise.all([readWorldSession(gameId, worldId, placement), awsControlPlaneSources.listHosts()]);
    const sessionId = located.record?.activeSessionId;
    if (located.record?.observedState !== "ready" || !sessionId) return { kind: "not_ready" };
    const target = await locateWorldHost(placement, located.record, hosts);
    return target === null ? { kind: "no_host" } : { kind: "ready", sessionId, target: { hostId: target.hostId, worldId, slot: target.slot } };
  },
  gateway: awsConsoleGateway,
  records: awsConsoleRecords,
  now: () => new Date(),
});
