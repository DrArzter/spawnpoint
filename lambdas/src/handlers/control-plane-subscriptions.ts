import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { controlPlaneConnectionItem, postToConnections, subscriptionTicketKey } from "../control-plane/subscriptions.ts";
import { isStreamBatch, streamChanges } from "../control-plane/dynamo-stream-changes.ts";
import { panelReloads } from "../control-plane/panel-changes.ts";
import { websocketConnections } from "../control-plane/aws-websocket-connections.ts";
import { dynamoTable } from "../control-plane/dynamo-table.ts";

type WebSocketEvent = Readonly<{
  routeKey?: string;
  requestContext?: { connectionId?: string; routeKey?: string };
  queryStringParameters?: Record<string, string | undefined>;
}>;

type Response = Readonly<{ statusCode: number; body: string }>;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// The composition root (ADR-0092): the clients, then the adapters over them.
const viewTable = required("CONTROL_PLANE_VIEW_TABLE");
const lifecycleTable = required("LIFECYCLE_TABLE_NAME");
const callbackUrl = required("CONTROL_PLANE_WEBSOCKET_CALLBACK_URL");

const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = dynamoTable(document);
const connections = websocketConnections(new ApiGatewayManagementApiClient({ endpoint: callbackUrl }));

function response(statusCode: number, body: string): Response {
  return { statusCode, body };
}

async function connect(event: WebSocketEvent): Promise<Response> {
  const connectionId = event.requestContext?.connectionId;
  const ticket = event.queryStringParameters?.ticket;
  if (!connectionId || !ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return response(401, "Unauthorized");

  const consumed = await table.delete({
    TableName: viewTable,
    Key: { pk: subscriptionTicketKey(ticket), sk: "CONTROL_PLANE" },
    ReturnValues: "ALL_OLD",
  });
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  const identityId = consumed.Attributes?.identity_id;
  const expiresAt = consumed.Attributes?.expires_at;
  if (typeof identityId !== "string" || typeof expiresAt !== "number" || expiresAt <= nowEpochSeconds) {
    return response(401, "Unauthorized");
  }

  await table.put({
    TableName: viewTable,
    Item: controlPlaneConnectionItem(connectionId, identityId, nowEpochSeconds),
  });
  return response(200, "Connected");
}

async function removeConnection(connectionId: string): Promise<void> {
  await table.delete({
    TableName: viewTable,
    Key: { pk: "SUBSCRIPTIONS#CONTROL_PLANE", sk: `CONNECTION#${connectionId}` },
  });
}

async function disconnect(event: WebSocketEvent): Promise<Response> {
  const connectionId = event.requestContext?.connectionId;
  if (connectionId) await removeConnection(connectionId);
  return response(200, "Disconnected");
}

async function publishInvalidation(observedAt: number): Promise<void> {
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const failures: unknown[] = [];
  do {
    const page = await table.query({ // NOSONAR paginated: the next token comes from the previous page
      TableName: viewTable,
      KeyConditionExpression: "pk = :pk",
      FilterExpression: "expires_at > :now",
      ExpressionAttributeValues: { ":pk": "SUBSCRIPTIONS#CONTROL_PLANE", ":now": nowEpochSeconds },
      ExclusiveStartKey: exclusiveStartKey,
    });
    const connectionIds = (page.Items ?? []).flatMap((item) => (typeof item.connection_id === "string" ? [item.connection_id] : []));
    try {
      await postToConnections(connectionIds, (connectionId) => connections.post(connectionId, { type: "control-plane-invalidated", observedAt }), removeConnection);
    } catch (error) {
      failures.push(error);
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  if (failures.length > 0) throw new AggregateError(failures, "some connections were not told");
}

// The message names nothing, so a batch that changed several records sends it once.
async function reloadPanels(batch: Readonly<{ Records: readonly unknown[] }>): Promise<void> {
  const reloads = panelReloads(streamChanges(batch), { lifecycle: lifecycleTable, view: viewTable });
  if (reloads.targets.length === 0) return;
  console.info("panel_reload", JSON.stringify({ targets: reloads.targets }));
  await publishInvalidation(reloads.observedAtEpochMilliseconds ?? Date.now());
}

export async function handler(event: unknown): Promise<Response | void> {
  if (isStreamBatch(event)) return reloadPanels(event);
  const socket = event as WebSocketEvent;
  const routeKey = socket.routeKey ?? socket.requestContext?.routeKey;
  if (routeKey === "$connect") return connect(socket);
  if (routeKey === "$disconnect") return disconnect(socket);
  return response(400, "Unsupported route");
}
