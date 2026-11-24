import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { type AccessTable, type Item } from "../../access/table.ts";
import { document } from "./aws-clients.ts";

export { document };
export type { Item };

const configuredTable = process.env.ACCESS_TABLE_NAME;
if (!configuredTable) throw new Error("missing environment variable: ACCESS_TABLE_NAME");

export const tableName: string = configuredTable;

/** The access table's port over the document client (ADR-0091). Each call reaches `client.send` when it runs. */
export function dynamoAccessTable(client: Pick<DynamoDBDocumentClient, "send">): AccessTable {
  return {
    get: async (input) => ({ Item: (await client.send(new GetCommand(input))).Item }),
    put: (input) => client.send(new PutCommand(input)),
    update: async (input) => ({ Attributes: (await client.send(new UpdateCommand(input))).Attributes }),
    delete: (input) => client.send(new DeleteCommand(input)),
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

export const accessTable: AccessTable = dynamoAccessTable(document);
