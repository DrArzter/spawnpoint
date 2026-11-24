import { awsConsoleGateway } from "../../control-plane/aws-ssm-console-gateway.ts";
import { awsConsoleRecords } from "./console-store.ts";
import { consoleFeature } from "./console.ts";
import { readyWorldSession, worldCatalog } from "./world-state.ts";

// The console as deployed: its ports bound to the AWS adapters. The routes
// and MCP use this; a test builds the feature with fakes instead.
export const deployedConsole = consoleFeature({
  catalog: worldCatalog,
  session: readyWorldSession,
  gateway: awsConsoleGateway,
  records: awsConsoleRecords,
  now: () => new Date(),
});
