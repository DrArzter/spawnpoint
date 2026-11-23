export { document } from "./clients.ts";

export type Item = Record<string, unknown>;

const configuredTable = process.env.ACCESS_TABLE_NAME;
if (!configuredTable) throw new Error("missing environment variable: ACCESS_TABLE_NAME");

export const tableName: string = configuredTable;
