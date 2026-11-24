import { type AccessTable, type Item } from "../../access/table.ts";
import { dynamoTable } from "../../control-plane/dynamo-table.ts";
import { document } from "./aws-clients.ts";

export { document };
export type { Item };

const configuredTable = process.env.ACCESS_TABLE_NAME;
if (!configuredTable) throw new Error("missing environment variable: ACCESS_TABLE_NAME");

export const tableName: string = configuredTable;

/** The table port over the API's document client; any table the API names goes through it (ADR-0091). */
export const accessTable: AccessTable = dynamoTable(document);
