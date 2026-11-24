import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import type { AccessTable } from "../access/table.ts";

/** Any DynamoDB table, through the table port (ADR-0091). */
export type Table = AccessTable;

/** The table port over a document client. Each call reaches `client.send` when it runs. */
export function dynamoTable(client: Pick<DynamoDBDocumentClient, "send">): Table {
  return {
    get: async (input) => ({ Item: (await client.send(new GetCommand(input))).Item }),
    put: (input) => client.send(new PutCommand(input)),
    update: async (input) => ({ Attributes: (await client.send(new UpdateCommand(input))).Attributes }),
    delete: async (input) => ({ Attributes: (await client.send(new DeleteCommand(input))).Attributes }),
    query: async (input) => {
      const page = await client.send(new QueryCommand(input));
      return { Items: page.Items, Count: page.Count, LastEvaluatedKey: page.LastEvaluatedKey };
    },
    scan: async (input) => {
      const page = await client.send(new ScanCommand(input));
      return { Items: page.Items, Count: page.Count, LastEvaluatedKey: page.LastEvaluatedKey };
    },
    transact: (input) => client.send(new TransactWriteCommand(input)),
  };
}
