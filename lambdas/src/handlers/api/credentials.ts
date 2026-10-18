import { type PasswordCredential, type PasswordCredentialStore, passwordProviderId } from "../../access/password-login-provider.ts";
import { UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { type SignInGuard, afterFailedSignIn, signInLocked } from "../../access/password-credential.ts";
import { type EmailAction } from "../../access/email-actions.ts";
import { type Identity } from "../../access/domain.ts";
import { type Item, document, tableName } from "./access-store.ts";
import { accountKeyFor } from "./identity-store.ts";

// Email and password is one login adapter among peers. Its credential is kept
// by normalized address, independently from the Identity it may be linked to;
// the provider sees one credential at a time and never the table.
export function credentialKey(email: string): Record<string, string> {
  return { pk: `CREDENTIAL#EMAIL#${email}`, sk: "PASSWORD" };
}

export function credentialFromItem(item: Item): PasswordCredential | null {
  if (typeof item.subject !== "string" || typeof item.email !== "string" || typeof item.password_hash !== "string") return null;
  return {
    subject: item.subject,
    email: item.email,
    emailVerified: item.email_verified === true,
    displayName: typeof item.display_name === "string" ? item.display_name : item.email,
    passwordHash: item.password_hash,
    guard: {
      failedSignIns: typeof item.failed_sign_ins === "number" ? item.failed_sign_ins : 0,
      lockedUntilEpochSeconds: typeof item.locked_until === "number" ? item.locked_until : null,
    },
  };
}

// The guard is bookkeeping about an attempt that has already been judged. A
// credential deleted between the read and this write must not turn a wrong
// password into a server error.
async function updateCredentialGuard(email: string, expression: string, values: Record<string, unknown>): Promise<void> {
  try {
    await document.send(new UpdateCommand({
      TableName: tableName,
      Key: credentialKey(email),
      UpdateExpression: expression,
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: values,
    }));
  } catch (error) {
    if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
  }
}

export const passwordCredentials: PasswordCredentialStore = {
  async find(email) {
    // Consistent, so a lock written a moment ago is seen by the next attempt.
    const result = await document.send(new GetCommand({ TableName: tableName, Key: credentialKey(email), ConsistentRead: true }));
    return result.Item === undefined ? null : credentialFromItem(result.Item);
  },
  async recordFailure(email, observed, nowSeconds) {
    let current: SignInGuard = observed;
    // A consistent read alone cannot serialize two Lambdas that both observed
    // the same count. Compare the count in the write and retry from the latest
    // credential so every accepted failure advances the guard exactly once.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const next = afterFailedSignIn(current, nowSeconds);
      const expectedMissingOrZero = current.failedSignIns === 0;
      try {
        await document.send(new UpdateCommand({
          TableName: tableName,
          Key: credentialKey(email),
          UpdateExpression: "SET failed_sign_ins = :failed, locked_until = :lockedUntil, last_failed_sign_in_at = :now",
          ConditionExpression: expectedMissingOrZero
            ? "attribute_exists(pk) AND (attribute_not_exists(failed_sign_ins) OR failed_sign_ins = :expected)"
            : "attribute_exists(pk) AND failed_sign_ins = :expected",
          ExpressionAttributeValues: {
            ":expected": current.failedSignIns,
            ":failed": next.failedSignIns,
            ":lockedUntil": next.lockedUntilEpochSeconds,
            ":now": new Date().toISOString(),
          },
        }));
        return;
      } catch (error) {
        if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
      }
      const latest = await this.find(email);
      if (latest === null || signInLocked(latest.guard, nowSeconds)) return;
      current = latest.guard;
    }
    throw new Error("password sign-in guard was updated too frequently");
  },
  recordSuccess: (email) => updateCredentialGuard(
    email,
    "SET failed_sign_ins = :zero, locked_until = :none, last_sign_in_at = :now",
    { ":zero": 0, ":none": null, ":now": new Date().toISOString() },
  ),
};

export function passwordCredentialItem(
  subject: string,
  email: string,
  displayName: string,
  passwordHash: string,
  action: EmailAction,
): Item {
  return {
    ...credentialKey(email),
    entity_type: "PASSWORD_CREDENTIAL",
    subject,
    email,
    email_verified: false,
    email_verification_nonce: action.nonce,
    display_name: displayName,
    password_hash: passwordHash,
    failed_sign_ins: 0,
    locked_until: null,
    created_at: new Date().toISOString(),
  };
}

export function passwordAccountItem(subject: string, email: string, displayName: string, identity: Identity): Item {
  const now = new Date().toISOString();
  return {
    pk: accountKeyFor(passwordProviderId, subject),
    sk: "ACCOUNT",
    platform: passwordProviderId,
    platform_user_id: subject,
    display_name: displayName,
    username: null,
    photo_url: null,
    email,
    first_seen_at: now,
    last_seen_at: now,
    status: "APPROVED",
    identity_id: identity.id,
    approved_at: now,
    approved_by: identity.id,
    gsi1pk: `IDENTITY#${identity.id}`,
    gsi1sk: now,
  };
}
