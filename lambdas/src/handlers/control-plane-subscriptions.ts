import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { controlPlaneConnectionItem, invalidatesPanels, postToConnections, subscriptionTicketKey } from "../control-plane/subscriptions.ts";
import { websocketConnections } from "../control-plane/aws-websocket-connections.ts";
import { dynamoTable } from "../control-plane/dynamo-table.ts";

type WebSocketEvent = Readonly<{
  routeKey?: string;
  requestContext?: { connectionId?: string; routeKey?: string };
  queryStringParameters?: Record<string, string | undefined>;
}>;

type ProjectionEvent = Readonly<{
  source?: string;
  "detail-type"?: string;
  detail?: { observedAtEpochMilliseconds?: unknown };
}>;

type Response = Readonly<{ statusCode: number; body: string }>;

const viewTable = process.env.CONTROL_PLANE_VIEW_TABLE;
if (!viewTable) throw new Error("CONTROL_PLANE_VIEW_TABLE is required");
const callbackUrl = process.env.CONTROL_PLANE_WEBSOCKET_CALLBACK_URL;
if (!callbackUrl) throw new Error("CONTROL_PLANE_WEBSOCKET_CALLBACK_URL is required");

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

async function disconnect(event: WebSocketEvent): Promise<Response> {
  const connectionId = event.requestContext?.connectionId;
  if (connectionId) {
    await table.delete({
      TableName: viewTable,
      Key: { pk: "SUBSCRIPTIONS#CONTROL_PLANE", sk: `CONNECTION#${connectionId}` },
    });
  }
  return response(200, "Disconnected");
}

async function removeConnection(connectionId: string): Promise<void> {
  await table.delete({
    TableName: viewTable,
    Key: { pk: "SUBSCRIPTIONS#CONTROL_PLANE", sk: `CONNECTION#${connectionId}` },
  });
}

async function publishInvalidation(event: ProjectionEvent): Promise<void> {
  const observedAt = event.detail?.observedAtEpochMilliseconds;
  if (typeof observedAt !== "number" || !Number.isSafeInteger(observedAt)) return;
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

export async function handler(event: WebSocketEvent | ProjectionEvent): Promise<Response | void> {
  if ("requestContext" in event) {
    const routeKey = event.routeKey ?? event.requestContext?.routeKey;
    if (routeKey === "$connect") return connect(event);
    if (routeKey === "$disconnect") return disconnect(event);
    return response(400, "Unsupported route");
  }
  if ("source" in event && invalidatesPanels(event)) {
    await publishInvalidation(event);
  }
}
