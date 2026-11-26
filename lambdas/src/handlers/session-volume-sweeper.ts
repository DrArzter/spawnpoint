import { EC2Client } from "@aws-sdk/client-ec2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { awsSessionVolumes } from "../control-plane/aws-session-volumes.ts";
import { sweepSessionVolumes } from "../control-plane/session-volume-sweep.ts";
import { dynamoLifecycleStores } from "../lifecycle/dynamo-lifecycle-stores.ts";

// The composition root (ADR-0092): the clients, then the ports over them.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const volumes = awsSessionVolumes(new EC2Client({}));

export async function handler(): Promise<void> {
  const { store } = dynamoLifecycleStores(document, required("LIFECYCLE_TABLE_NAME"));
  const result = await sweepSessionVolumes(volumes, store, Math.floor(Date.now() / 1000), console);
  // A thrown error is what the alarm counts: a volume survived this sweep.
  if (result.survivors.length > 0) throw new Error(`Session volumes need review: ${result.survivors.join("; ")}`);
}
