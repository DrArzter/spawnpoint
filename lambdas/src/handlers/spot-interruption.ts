import { EC2Client } from "@aws-sdk/client-ec2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SFNClient } from "@aws-sdk/client-sfn";

import { awsSessionMoves } from "../control-plane/aws-session-moves.ts";
import { awsSessionVolumes } from "../control-plane/aws-session-volumes.ts";
import { interruptionEvent, markHostSessionsMoving, moveHostSessions } from "../control-plane/spot-interruption.ts";
import { dynamoLifecycleStores } from "../lifecycle/dynamo-lifecycle-stores.ts";

// The composition root (ADR-0092): the clients, then the ports over them.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const volumes = awsSessionVolumes(new EC2Client({}));
const sfn = new SFNClient({});

export async function handler(event: unknown): Promise<unknown> {
  const parsed = interruptionEvent(event);
  if (parsed === null) return { result: "ignored" };
  const { store, placementStore } = dynamoLifecycleStores(document, required("LIFECYCLE_TABLE_NAME"));
  const ports = {
    placement: placementStore,
    lifecycle: store,
    volumes,
    moves: awsSessionMoves(sfn, required("START_STATE_MACHINE_ARN"), process.env.SPAWNPOINT_APP_COMMIT || "main"),
  };
  const now = Math.floor(Date.now() / 1000);
  switch (parsed.kind) {
    case "warning": return markHostSessionsMoving(ports, parsed.hostId, now, console);
    case "terminated": return moveHostSessions(ports, parsed.hostId, now, console);
    case "saved":
      console.info("host saved its sessions for the interruption", JSON.stringify(parsed.report));
      return { result: "recorded" };
  }
}
