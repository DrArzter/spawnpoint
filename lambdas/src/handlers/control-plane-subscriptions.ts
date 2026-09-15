import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { controlPlaneConnectionItem, subscriptionTicketKey } from "../control-plane/subscriptions.ts";

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
const connections = new ApiGatewayManagementApiClient({ endpoint: callbackUrl });

function response(statusCode: number, body: string): Response {
  return { statusCode, body };
}

async function connect(event: WebSocketEvent): Promise<Response> {
  const connectionId = event.requestContext?.connectionId;
  const ticket = event.queryStringParameters?.ticket;
  if (!connectionId || !ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return response(401, "Unauthorized");

  const consumed = await document.send(new DeleteCommand({
    TableName: viewTable,
    Key: { pk: subscriptionTicketKey(ticket), sk: "CONTROL_PLANE" },
    ReturnValues: "ALL_OLD",
  }));
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  const identityId = consumed.Attributes?.identity_id;
  const expiresAt = consumed.Attributes?.expires_at;
  if (typeof identityId !== "string" || typeof expiresAt !== "number" || expiresAt <= nowEpochSeconds) {
    return response(401, "Unauthorized");
  }

  await document.send(new PutCommand({
    TableName: viewTable,
    Item: controlPlaneConnectionItem(connectionId, identityId, nowEpochSeconds),
  }));
  return response(200, "Connected");
}

async function disconnect(event: WebSocketEvent): Promise<Response> {
  const connectionId = event.requestContext?.connectionId;
  if (connectionId) {
    await document.send(new DeleteCommand({
      TableName: viewTable,
      Key: { pk: "SUBSCRIPTIONS#CONTROL_PLANE", sk: `CONNECTION#${connectionId}` },
    }));
  }
  return response(200, "Disconnected");
}

async function removeConnection(connectionId: string): Promise<void> {
  await document.send(new DeleteCommand({
    TableName: viewTable,
    Key: { pk: "SUBSCRIPTIONS#CONTROL_PLANE", sk: `CONNECTION#${connectionId}` },
  }));
}

async function publishInvalidation(event: ProjectionEvent): Promise<void> {
  const observedAt = event.detail?.observedAtEpochMilliseconds;
  if (typeof observedAt !== "number" || !Number.isSafeInteger(observedAt)) return;
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await document.send(new QueryCommand({
      TableName: viewTable,
      KeyConditionExpression: "pk = :pk",
      FilterExpression: "expires_at > :now",
      ExpressionAttributeValues: { ":pk": "SUBSCRIPTIONS#CONTROL_PLANE", ":now": nowEpochSeconds },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    await Promise.all((page.Items ?? []).map(async (item) => {
      const connectionId = item.connection_id;
      if (typeof connectionId !== "string") return;
      try {
        await connections.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(JSON.stringify({ type: "control-plane-invalidated", observedAt })),
        }));
      } catch (error) {
        if (error instanceof GoneException || (error instanceof Error && error.name === "GoneException")) {
          await removeConnection(connectionId);
          return;
        }
        throw error;
      }
    }));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
}

export async function handler(event: WebSocketEvent | ProjectionEvent): Promise<Response | void> {
  if ("requestContext" in event) {
    const routeKey = event.routeKey ?? event.requestContext?.routeKey;
    if (routeKey === "$connect") return connect(event);
    if (routeKey === "$disconnect") return disconnect(event);
    return response(400, "Unsupported route");
  }
  if ("source" in event && event.source === "spawnpoint.control-plane" && event["detail-type"] === "Projection Updated") {
    await publishInvalidation(event);
  }
}
