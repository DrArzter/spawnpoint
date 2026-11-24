// The access table's port (ADR-0091): reads and writes in the shape DynamoDB's
// document client takes them, so the access code builds them without the SDK
// and an adapter (handlers/api/access-store.ts) sends them.

export type Item = Record<string, unknown>;

/**
 * An item as the table returns it. The document client types attributes as
 * `any`, and the readers narrow each one where they use it; the port keeps
 * that contract rather than retyping every reader in the same change.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the document client's own item type
export type StoredItem = Record<string, any>; // NOSONAR the document client's own item type

type Expressions = {
  ConditionExpression?: string | undefined;
  ExpressionAttributeNames?: Record<string, string> | undefined;
  ExpressionAttributeValues?: Record<string, unknown> | undefined;
};

export type TableGet = { TableName: string; Key: Record<string, unknown>; ConsistentRead?: boolean | undefined; ProjectionExpression?: string | undefined; ExpressionAttributeNames?: Record<string, string> | undefined };

export type TableUpdate = Expressions & {
  TableName: string;
  Key: Record<string, unknown>;
  UpdateExpression: string;
  ReturnValues?: "NONE" | "ALL_OLD" | "UPDATED_OLD" | "ALL_NEW" | "UPDATED_NEW" | undefined;
};

export type TablePut = Expressions & { TableName: string; Item: Record<string, unknown> };

export type TableCheck = Expressions & { TableName: string; Key: Record<string, unknown>; ConditionExpression: string };

export type TableDelete = Expressions & { TableName: string; Key: Record<string, unknown> };

export type TableQuery = Expressions & {
  TableName: string;
  IndexName?: string | undefined;
  KeyConditionExpression: string;
  FilterExpression?: string | undefined;
  ProjectionExpression?: string | undefined;
  ScanIndexForward?: boolean | undefined;
  Limit?: number | undefined;
  ConsistentRead?: boolean | undefined;
  Select?: "ALL_ATTRIBUTES" | "ALL_PROJECTED_ATTRIBUTES" | "SPECIFIC_ATTRIBUTES" | "COUNT" | undefined;
  ExclusiveStartKey?: Record<string, unknown> | undefined;
};

export type TableScan = Expressions & {
  TableName: string;
  IndexName?: string | undefined;
  FilterExpression?: string | undefined;
  ProjectionExpression?: string | undefined;
  Limit?: number | undefined;
  ConsistentRead?: boolean | undefined;
  ExclusiveStartKey?: Record<string, unknown> | undefined;
};

/** One item of a transaction: exactly one of the four. */
export type TableTransactItem = { Put?: TablePut | undefined; Update?: TableUpdate | undefined; ConditionCheck?: TableCheck | undefined; Delete?: TableDelete | undefined };

export type TablePage = { Items?: StoredItem[] | undefined; Count?: number | undefined; LastEvaluatedKey?: Record<string, unknown> | undefined };

export type AccessTable = Readonly<{
  get: (input: TableGet) => Promise<{ Item?: StoredItem | undefined }>;
  put: (input: TablePut) => Promise<unknown>;
  update: (input: TableUpdate) => Promise<{ Attributes?: StoredItem | undefined }>;
  delete: (input: TableDelete) => Promise<unknown>;
  query: (input: TableQuery) => Promise<TablePage>;
  scan: (input: TableScan) => Promise<TablePage>;
  transact: (input: { TransactItems: TableTransactItem[] }) => Promise<unknown>;
}>;
