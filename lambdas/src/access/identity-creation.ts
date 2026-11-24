import { type TableTransactItem } from "./table.ts";
import { accountItemKey, activeIdentityIndex, identityIndex, loginProviderKey, profileKey } from "./keys.ts";

type TransactItems = TableTransactItem[];

export type NewIdentity = Readonly<{
  tableName: string;
  identityId: string;
  account: Readonly<{ provider: string; subject: string }>;
  displayName: string;
  roleId: string;
  directGrants: readonly string[];
  // "bootstrap" for the first Owner, otherwise the id of the approving identity.
  createdBy: string;
  now: string;
}>;

/** The item that names an account on its identity, so deletion finds the account while the index lags. */
export function loginProviderMarker(identityId: string, provider: string, subject: string, createdAt: string): Record<string, unknown> {
  return {
    ...loginProviderKey(identityId, provider),
    entity_type: "IDENTITY_LOGIN_PROVIDER", provider, subject, created_at: createdAt,
  };
}

/**
 * The writes that create an identity from a known account: the profile, the
 * account link and the login provider marker. The link needs the account item
 * to exist and to have no identity, so two approvals cannot both win.
 */
export function createIdentity(input: NewIdentity): TransactItems {
  const { tableName, identityId, account, displayName, roleId, directGrants, createdBy, now } = input;
  return [
    { Put: { TableName: tableName, Item: {
      ...profileKey(identityId), identity_id: identityId, display_name: displayName,
      role_id: roleId, direct_grants: directGrants, status: "ACTIVE", created_at: now,
      created_by: createdBy, gsi1pk: activeIdentityIndex, gsi1sk: displayName.toLowerCase(),
    }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Update: { TableName: tableName, Key: accountItemKey(account.provider, account.subject),
      UpdateExpression: "SET identity_id = :identityId, #status = :approved, gsi1pk = :linked, gsi1sk = :now, approved_at = :now, approved_by = :by",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":identityId": identityId, ":approved": "APPROVED", ":linked": identityIndex(identityId), ":now": now, ":by": createdBy },
    } },
    { Put: { TableName: tableName, Item: loginProviderMarker(identityId, account.provider, account.subject, now),
      ConditionExpression: "attribute_not_exists(pk)" } },
  ];
}
