import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { ChangeResourceRecordSetsCommand, ListResourceRecordSetsCommand, Route53Client } from "@aws-sdk/client-route-53";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { awsControlPlaneSources, stopSessionExecution } from "../control-plane/aws.ts";
import { eventJournalItem, recoveryTarget, type ControlPlaneEvent } from "../control-plane/dynamic-projection.ts";
import { gameCatalog } from "../control-plane/catalog.ts";
import { dnsLedgerRecords, terminalHostInstanceId, type DnsLedgerRecord } from "../control-plane/dns-ledger.ts";

const viewTable = process.env.CONTROL_PLANE_VIEW_TABLE;
if (!viewTable) throw new Error("CONTROL_PLANE_VIEW_TABLE is required");

const document = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const events = new EventBridgeClient({});
const route53 = new Route53Client({});
const dnsZoneId = process.env.GAME_DNS_ZONE_ID;
const dnsSuffix = process.env.GAME_DNS_SUFFIX;
const lifecycleTable = process.env.LIFECYCLE_TABLE_NAME;

function conditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

async function recordEvent(event: ControlPlaneEvent, nowEpochSeconds: number): Promise<void> {
  try {
    await document.send(new PutCommand({
      TableName: viewTable,
      Item: eventJournalItem(event, nowEpochSeconds + 90 * 24 * 60 * 60),
      ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    }));
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
  }
}

async function writeProjection(eventId: string, observedAtEpochMilliseconds: number): Promise<{
  hosts: Awaited<ReturnType<typeof awsControlPlaneSources.listHosts>>;
  operations: Awaited<ReturnType<typeof awsControlPlaneSources.listRunningOperations>>;
  written: boolean;
}> {
  const [hosts, operations] = await Promise.all([
    awsControlPlaneSources.listHosts(),
    awsControlPlaneSources.listRunningOperations(),
  ]);
  let written = true;
  try {
    await document.send(new PutCommand({
      TableName: viewTable,
      Item: {
        pk: "PROJECTION#CONTROL_PLANE",
        sk: "DYNAMIC",
        schema_version: 1,
        observed_at_epoch_ms: observedAtEpochMilliseconds,
        observed_at: new Date(observedAtEpochMilliseconds).toISOString(),
        source_event_id: eventId,
        hosts,
        operations,
      },
      ConditionExpression: "attribute_not_exists(pk) OR observed_at_epoch_ms < :observed_at",
      ExpressionAttributeValues: { ":observed_at": observedAtEpochMilliseconds },
    }));
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    written = false;
  }
  return { hosts, operations, written };
}

async function publishProjectionInvalidation(
  eventId: string,
  observedAtEpochMilliseconds: number,
): Promise<void> {
  const published = await events.send(new PutEventsCommand({ Entries: [{
    Source: "spawnpoint.control-plane",
    DetailType: "Projection Updated",
    Detail: JSON.stringify({ schemaVersion: 1, sourceEventId: eventId, observedAtEpochMilliseconds }),
  }] }));
  if ((published.FailedEntryCount ?? 0) > 0) {
    throw new Error(published.Entries?.[0]?.ErrorMessage ?? "EventBridge rejected projection invalidation");
  }
}

async function reconcileStoppedHost(
  eventId: string,
  hosts: Awaited<ReturnType<typeof awsControlPlaneSources.listHosts>>,
  operations: Awaited<ReturnType<typeof awsControlPlaneSources.listRunningOperations>>,
  nowEpochSeconds: number,
): Promise<void> {
  const lifecycles = (await Promise.all(gameCatalog.map((game) => awsControlPlaneSources.readLifecycle(game.id))))
    .filter((record) => record !== null);
  const target = recoveryTarget(hosts, operations, lifecycles, nowEpochSeconds);
  if (target === null) return;
  const operationId = `reconcile-${target.serverId}-${eventId}`.slice(0, 80);
  try {
    await stopSessionExecution(
      operationId,
      target.instanceId,
      "eventbridge:control-plane-reconciler",
      target.serverId,
      target.sessionId,
      target.worldId,
    );
  } catch (error) {
    if (!(error instanceof Error && error.name === "ExecutionAlreadyExists")) throw error;
  }
}

async function currentDnsRecord(record: DnsLedgerRecord): Promise<boolean> {
  const result = await route53.send(new ListResourceRecordSetsCommand({
    HostedZoneId: record.zoneId,
    StartRecordName: record.name,
    StartRecordType: "A",
    MaxItems: 1,
  }));
  const current = result.ResourceRecordSets?.[0];
  return current?.Name?.toLowerCase() === record.name && current.Type === "A" &&
    current.TTL === 30 && current.ResourceRecords?.length === 1 &&
    current.ResourceRecords[0]?.Value === record.address;
}

async function deleteDnsRecord(record: DnsLedgerRecord): Promise<void> {
  if (!(await currentDnsRecord(record))) return;
  try {
    await route53.send(new ChangeResourceRecordSetsCommand({
      HostedZoneId: record.zoneId,
      ChangeBatch: { Changes: [{
        Action: "DELETE",
        ResourceRecordSet: {
          Name: record.name, Type: "A", TTL: 30,
          ResourceRecords: [{ Value: record.address }],
        },
      }] },
    }));
  } catch (error) {
    if (!(error instanceof Error && error.name === "InvalidChangeBatch" && !(await currentDnsRecord(record)))) throw error;
  }
}

async function cleanTerminalHostDns(event: ControlPlaneEvent): Promise<void> {
  const instanceId = terminalHostInstanceId(event);
  if (instanceId === null || !dnsZoneId || !dnsSuffix || !lifecycleTable) return;
  const key = { server_id: `dns-host#${instanceId}` };
  const result = await document.send(new GetCommand({ TableName: lifecycleTable, Key: key }));
  if (!result.Item) return;
  for (const record of dnsLedgerRecords(result.Item, dnsZoneId, dnsSuffix)) await deleteDnsRecord(record);
  await document.send(new DeleteCommand({ TableName: lifecycleTable, Key: key }));
}

export async function handler(event: ControlPlaneEvent): Promise<void> {
  const observedAtEpochMilliseconds = Date.now();
  const nowEpochSeconds = Math.floor(observedAtEpochMilliseconds / 1000);
  await cleanTerminalHostDns(event);
  await recordEvent(event, nowEpochSeconds);
  const { hosts, operations, written } = await writeProjection(event.id, observedAtEpochMilliseconds);
  if (written) await publishProjectionInvalidation(event.id, observedAtEpochMilliseconds);
  await reconcileStoppedHost(event.id, hosts, operations, nowEpochSeconds);
}
