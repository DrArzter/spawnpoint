import { S3Client } from "@aws-sdk/client-s3";

import { applyBackupRetention } from "../control-plane/backup-retention.ts";
import { s3RetentionStore } from "../control-plane/s3-backup-retention.ts";
import { S3WorldReader } from "../control-plane/s3-world-repository.ts";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
}

export async function handler(): Promise<Readonly<{ worlds: number; removed: number }>> {
  const s3 = new S3Client({});
  const releaseBucket = requiredEnv("RELEASE_BUCKET");
  const store = s3RetentionStore(s3, requiredEnv("BACKUP_BUCKET"), new S3WorldReader(s3, releaseBucket), releaseBucket);
  const results = await applyBackupRetention(store);
  for (const result of results) {
    if (result.removed.length > 0) console.info("backup_retention_removed", { worldId: result.worldId, keys: result.removed });
  }
  const failed = results.filter((result) => result.result === "failed").map((result) => result.worldId);
  // Throwing after every world was tried counts as a Lambda error, which the alarm reports.
  if (failed.length > 0) throw new Error(`backup retention failed for ${failed.join(", ")}`);
  return { worlds: results.length, removed: results.reduce((sum, result) => sum + result.removed.length, 0) };
}
