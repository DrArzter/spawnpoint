import { awsControlPlaneSources } from "../../control-plane/aws.ts";
import { awsSessionMachines } from "../../control-plane/aws-session-machines.ts";
import { awsConsoleGateway } from "../../control-plane/aws-ssm-console-gateway.ts";
import { awsWorldRecords } from "../../control-plane/aws-world-records.ts";
import { awsBackupArchives } from "../../control-plane/s3-backup-archives.ts";
import { worldsFeature } from "./worlds.ts";

// The world operations as deployed: their ports bound to the AWS adapters. The
// sources are the shared object, read at request time.
export const deployedWorlds = worldsFeature({
  sources: awsControlPlaneSources,
  worlds: awsWorldRecords,
  machines: awsSessionMachines,
  gateway: awsConsoleGateway,
  backupReleases: () => awsBackupArchives.releaseSources(),
});
