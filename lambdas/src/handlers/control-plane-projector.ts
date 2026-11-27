import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { Route53Client } from "@aws-sdk/client-route-53";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { awsControlPlaneSources, describeRunningOperation } from "../control-plane/aws.ts";
import { writeProjection, type StoredProjection } from "../control-plane/projection-writer.ts";
import { awsSessionMachines } from "../control-plane/aws-session-machines.ts";
import { eventJournalItem, hostOwnsSession, recoveryTarget, type ControlPlaneEvent } from "../control-plane/dynamic-projection.ts";
import { gameCatalog } from "../control-plane/catalog.ts";
import { parkDnsRecord } from "../control-plane/aws-dns-ledger.ts";
import { dnsLedgerRecords, terminalHostInstanceId } from "../control-plane/dns-ledger.ts";
import { dynamoTable } from "../control-plane/dynamo-table.ts";

const viewTable = process.env.CONTROL_PLANE_VIEW_TABLE;
if (!viewTable) throw new Error("CONTROL_PLANE_VIEW_TABLE is required");

const document = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const table = dynamoTable(document);
const route53 = new Route53Client({});
const dnsZoneId = process.env.GAME_DNS_ZONE_ID;
const dnsSuffix = process.env.GAME_DNS_SUFFIX;
const lifecycleTable = process.env.LIFECYCLE_TABLE_NAME;

function conditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

async function recordEvent(event: ControlPlaneEvent, nowEpochSeconds: number): Promise<void> {
  try {
    await table.put({
      TableName: viewTable,
      Item: eventJournalItem(event, nowEpochSeconds + 90 * 24 * 60 * 60),
      ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    });
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
  }
}

async function putProjection(projection: StoredProjection): Promise<boolean> {
  try {
    await table.put({
      TableName: viewTable,
      Item: {
        pk: "PROJECTION#CONTROL_PLANE",
        sk: "DYNAMIC",
        schema_version: 1,
        observed_at_epoch_ms: projection.observedAtEpochMilliseconds,
        observed_at: new Date(projection.observedAtEpochMilliseconds).toISOString(),
        source_event_id: projection.sourceEventId,
        hosts: projection.hosts,
        operations: projection.operations,
      },
      ConditionExpression: "attribute_not_exists(pk) OR observed_at_epoch_ms < :observed_at",
      ExpressionAttributeValues: { ":observed_at": projection.observedAtEpochMilliseconds },
    });
    return true;
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    return false;
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
  if (target === null || !lifecycleTable) return;
  // The projection observes the configured EC2 host, but an active Fleet
  // session may live elsewhere. Never reconcile it just because that unrelated
  // configured host is stopped.
  const placedHost = await table.get({
    TableName: lifecycleTable,
    Key: { server_id: `host#${target.instanceId}` },
    ConsistentRead: true,
  });
  if (!hostOwnsSession(placedHost.Item?.host, target.instanceId, target.sessionId)) return;
  const operationId = `reconcile-${target.serverId}-${eventId}`.slice(0, 80);
  try {
    await awsSessionMachines.stop({
      operationId,
      instanceId: target.instanceId,
      requestedBy: "eventbridge:control-plane-reconciler",
      serverId: target.serverId,
      sessionId: target.sessionId,
      worldId: target.worldId,
    });
  } catch (error) {
    if (!(error instanceof Error && error.name === "ExecutionAlreadyExists")) throw error;
  }
}

async function cleanTerminalHostDns(event: ControlPlaneEvent): Promise<void> {
  const instanceId = terminalHostInstanceId(event);
  if (instanceId === null || !dnsZoneId || !dnsSuffix || !lifecycleTable) return;
  const key = { server_id: `dns-host#${instanceId}` };
  const result = await table.get({ TableName: lifecycleTable, Key: key });
  if (!result.Item) return;
  for (const record of dnsLedgerRecords(result.Item, dnsZoneId, dnsSuffix)) await parkDnsRecord(route53, record); // NOSONAR sequential to stay inside the Route 53 change rate
  await table.delete({ TableName: lifecycleTable, Key: key });
}

export async function handler(event: ControlPlaneEvent): Promise<void> {
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  await cleanTerminalHostDns(event);
  await recordEvent(event, nowEpochSeconds);
  // A written projection reaches open panels through the view table's stream (ADR-0104).
  const { hosts, operations } = await writeProjection({
    listHosts: awsControlPlaneSources.listHosts,
    listRunningOperations: awsControlPlaneSources.listRunningOperations,
    describeRunningOperation,
    putProjection,
    now: Date.now,
  }, event);
  await reconcileStoppedHost(event.id, hosts, operations, nowEpochSeconds);
}
