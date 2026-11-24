import { type ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

/** The panel's live connections (ADR-0057): a message reaches one, or it is gone. */
export type Connections = Readonly<{ post: (connectionId: string, message: unknown) => Promise<"sent" | "gone"> }>;

export function websocketConnections(client: Pick<ApiGatewayManagementApiClient, "send">): Connections {
  return {
    async post(connectionId, message) {
      try {
        await client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(message)) }));
        return "sent";
      } catch (error) {
        if (error instanceof GoneException || (error instanceof Error && error.name === "GoneException")) return "gone";
        throw error;
      }
    },
  };
}
