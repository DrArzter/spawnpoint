import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Identity, builtInRoles, defaultRoleId, isProtectedRoleId } from "../../access/domain.ts";
import { accessDefaultsKey, accessIndexName, activeIdentityIndex, roleIndex, roleKey } from "../../access/keys.ts";
import { type RoleInput, type StoredRole, resolveRole } from "../../access/roles.ts";
import { document, tableName } from "./access-store.ts";
import { isConditionFailure } from "./conditions.ts";

// Reads and writes of panel role records (ADR-0083). Every read is consistent
// and nothing is cached across requests: a role edit applies to the next request.

export async function readRole(roleId: string): Promise<StoredRole | null> {
  if (isProtectedRoleId(roleId)) return resolveRole(roleId, undefined);
  const found = await document.send(new GetCommand({ TableName: tableName, Key: roleKey(roleId), ConsistentRead: true }));
  return resolveRole(roleId, found.Item);
}

/** The identity with the role it holds for this request. */
export async function withRole(identity: Identity): Promise<Identity> {
  return { ...identity, role: await readRole(identity.roleId) };
}

/** Every role: the stored ones and the built-in ones that have no record yet. */
export async function listRoles(): Promise<StoredRole[]> {
  const stored = new Map<string, StoredRole>();
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await document.send(new QueryCommand({ // NOSONAR paginated: the next token comes from the previous page
      TableName: tableName, IndexName: accessIndexName, KeyConditionExpression: "gsi1pk = :roles",
      ExpressionAttributeValues: { ":roles": roleIndex }, ExclusiveStartKey: cursor,
    }));
    for (const item of page.Items ?? []) {
      const roleId = String(item.role_id);
      const role = resolveRole(roleId, item);
      if (role !== null && !isProtectedRoleId(roleId)) stored.set(roleId, role);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor !== undefined);
  const builtIn = Object.keys(builtInRoles).map((roleId) => stored.get(roleId) ?? resolveRole(roleId, undefined)!);
  const custom = [...stored.values()].filter((role) => !role.builtIn).sort((a, b) => a.name.localeCompare(b.name));
  return [...builtIn, ...custom];
}

/** How many active identities hold each role. Read from the index, so it can lag a write. */
export async function roleHolders(): Promise<ReadonlyMap<string, number>> {
  const counts = new Map<string, number>();
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await document.send(new QueryCommand({ // NOSONAR paginated: the next token comes from the previous page
      TableName: tableName, IndexName: accessIndexName, KeyConditionExpression: "gsi1pk = :state",
      ExpressionAttributeValues: { ":state": activeIdentityIndex }, ProjectionExpression: "role_id", ExclusiveStartKey: cursor,
    }));
    for (const item of page.Items ?? []) counts.set(String(item.role_id), (counts.get(String(item.role_id)) ?? 0) + 1);
    cursor = page.LastEvaluatedKey;
  } while (cursor !== undefined);
  return counts;
}

export type WriteResult = Readonly<{ role: StoredRole }> | Readonly<{ conflict: "role_exists" | "role_changed" }>;

function record(roleId: string, input: RoleInput, version: number, by: string): Record<string, unknown> {
  return {
    ...roleKey(roleId), role_id: roleId, name: input.name, description: input.description, permissions: [...input.permissions],
    version, updated_at: new Date().toISOString(), updated_by: by, gsi1pk: roleIndex, gsi1sk: roleId,
  };
}

/** A new role. A built-in id counts as taken, record or not. */
export async function createRole(roleId: string, input: RoleInput, by: string): Promise<WriteResult> {
  if (resolveRole(roleId, undefined) !== null) return { conflict: "role_exists" };
  try {
    await document.send(new PutCommand({ TableName: tableName, Item: record(roleId, input, 1, by), ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (error) {
    if (isConditionFailure(error)) return { conflict: "role_exists" };
    throw error;
  }
  return { role: resolveRole(roleId, record(roleId, input, 1, by))! };
}

/**
 * A changed role, only when the caller saw its current version. A built-in
 * role's first edit writes its record, from the version its code definition has.
 */
export async function updateRole(current: StoredRole, input: RoleInput, version: number, by: string): Promise<WriteResult> {
  if (version !== current.version) return { conflict: "role_changed" };
  const next = record(current.id, input, version + 1, by);
  try {
    await document.send(new PutCommand({
      TableName: tableName, Item: next,
      ConditionExpression: "(attribute_not_exists(pk) AND :version = :first) OR version = :version",
      ExpressionAttributeValues: { ":version": version, ":first": 1 },
    }));
  } catch (error) {
    if (isConditionFailure(error)) return { conflict: "role_changed" };
    throw error;
  }
  return { role: resolveRole(current.id, next)! };
}

export async function deleteRole(roleId: string, version: number): Promise<"deleted" | "role_changed"> {
  try {
    await document.send(new DeleteCommand({
      TableName: tableName, Key: roleKey(roleId), ConditionExpression: "version = :version",
      ExpressionAttributeValues: { ":version": version },
    }));
  } catch (error) {
    if (isConditionFailure(error)) return "role_changed";
    throw error;
  }
  return "deleted";
}

/** The role a new person gets: the stored choice, or Viewer when none is stored. */
export async function readDefaultRoleId(): Promise<string> {
  const found = await document.send(new GetCommand({ TableName: tableName, Key: accessDefaultsKey, ConsistentRead: true }));
  return typeof found.Item?.default_role_id === "string" ? found.Item.default_role_id : defaultRoleId;
}

export async function writeDefaultRoleId(roleId: string, by: string): Promise<void> {
  await document.send(new UpdateCommand({
    TableName: tableName, Key: accessDefaultsKey,
    UpdateExpression: "SET default_role_id = :role, updated_at = :now, updated_by = :by",
    ExpressionAttributeValues: { ":role": roleId, ":now": new Date().toISOString(), ":by": by },
  }));
}
