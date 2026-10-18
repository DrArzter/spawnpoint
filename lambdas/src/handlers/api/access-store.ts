export { document } from "./clients.ts";

export type Item = Record<string, unknown>;

export const tableName = process.env.ACCESS_TABLE_NAME;
if (!tableName) throw new Error("missing environment variable: ACCESS_TABLE_NAME");
