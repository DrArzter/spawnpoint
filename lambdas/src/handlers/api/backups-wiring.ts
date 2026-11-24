import { readWorldRecord } from "../../control-plane/aws.ts";
import { awsBackupArchives } from "../../control-plane/s3-backup-archives.ts";
import { backupsFeature } from "./backups.ts";
import { awsBackupDownloads } from "./download-store.ts";
import { knownWorld } from "./world-state.ts";

// The backups as deployed: their ports bound to the AWS adapters.
export const deployedBackups = backupsFeature({
  knownWorld,
  readWorldRecord,
  archives: awsBackupArchives,
  downloads: awsBackupDownloads,
  now: () => new Date(),
});
