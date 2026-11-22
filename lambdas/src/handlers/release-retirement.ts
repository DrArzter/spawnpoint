import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { dynamoRetirementTable } from "../control-plane/dynamo-release-retirement.ts";
import { RELEASE_REFS_TABLE_DEFAULT } from "../control-plane/release-objects.ts";
import { retireRelease, type RetirementDeps, type RetirementResult } from "../control-plane/release-retirement.ts";
import { retirementPorts } from "../control-plane/s3-release-retirement.ts";
import { s3BackupBucketReader, s3ReleaseBucketReader } from "../control-plane/s3-release-marks.ts";

// ADR-0080 retirement. The panel's API invokes this Lambda asynchronously after
// it checked the owner's permission and the typed confirmation; this Lambda
// checks the confirmation again and never trusts the caller. The logs record
// who asked and what happened. The role has no s3:Delete*: only the table changes.

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Without secrets or file lists: the result's counters and the stop reason. */
function summary(result: RetirementResult): Record<string, unknown> {
  const { status, gameId, presetId, release, error, examples, holdersRemoved, referencesRemoved, condemned, driftRepaired, catalogChanged, alreadyRetired } = result;
  return { status, gameId, presetId, release, error, examples, holdersRemoved, referencesRemoved, condemned, driftRepaired, catalogChanged, alreadyRetired };
}

export async function retire(event: unknown, deps: RetirementDeps): Promise<RetirementResult> {
  const input = (event ?? {}) as Record<string, unknown>;
  console.info(JSON.stringify({
    event: "release_retirement_requested", gameId: input.gameId, presetId: input.presetId, release: input.release,
    requestedBy: typeof input.requestedBy === "string" ? input.requestedBy : null,
  }));
  try {
    const result = await retireRelease(event, deps);
    // A refusal or an abort is an answer, not a failure: returning keeps Lambda from retrying it.
    console.info(JSON.stringify({ event: "release_retirement_result", requestedBy: input.requestedBy, ...summary(result) }));
    return result;
  } catch (error) {
    // The release may stay `retiring`: Lambda's own retry resumes it, and so does a new request.
    console.error("release_retirement_failed", { gameId: input.gameId, presetId: input.presetId, release: input.release, errorName: error instanceof Error ? error.name : "UnknownError" });
    throw error;
  }
}

export async function handler(event: unknown): Promise<RetirementResult> {
  const s3 = new S3Client({});
  const ports = { release: s3ReleaseBucketReader(s3, requiredEnv("RELEASE_BUCKET")), backup: s3BackupBucketReader(s3, requiredEnv("BACKUP_BUCKET")) };
  const table = process.env.RELEASE_REFS_TABLE ?? RELEASE_REFS_TABLE_DEFAULT;
  return retire(event, {
    table: dynamoRetirementTable(DynamoDBDocumentClient.from(new DynamoDBClient({})), table),
    ...retirementPorts(s3, ports, requiredEnv("RELEASE_BUCKET"), () => new Date()),
  });
}
