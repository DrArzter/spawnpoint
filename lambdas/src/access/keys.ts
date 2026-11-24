// The one owner of every access-table key and index value. A shape is built
// here and parsed here, so identity deletion cannot drift from the writers.
// The strings are stored data: change none of them.

export type TableKey = Readonly<{ pk: string; sk: string }>;

export const accessIndexName = "gsi1";

const identityPrefix = "IDENTITY#";
const telegramPrefix = "TELEGRAM#";
const accountPrefix = "ACCOUNT#";
const loginProviderPrefix = "LOGIN_PROVIDER#";

export const profileSort = "PROFILE";
export const accountSort = "ACCOUNT";
export const loginProviderSortPrefix = loginProviderPrefix;

/** Partition of one identity: its profile, settings and login provider markers. */
export const identityPartition = (identityId: string): string => `${identityPrefix}${identityId}`;

export const identityIdFromPartition = (partition: string): string | null =>
  partition.startsWith(identityPrefix) ? partition.slice(identityPrefix.length) : null;

export const profileKey = (identityId: string): TableKey => ({ pk: identityPartition(identityId), sk: profileSort });

export const identitySettingKey = (identityId: string, setting: "SUBSCRIPTIONS" | "APPEARANCE"): TableKey =>
  ({ pk: identityPartition(identityId), sk: setting });

export const loginProviderKey = (identityId: string, provider: string): TableKey =>
  ({ pk: identityPartition(identityId), sk: `${loginProviderPrefix}${provider}` });

export const isLoginProviderSort = (sort: string): boolean => sort.startsWith(loginProviderPrefix);

// Telegram keeps its first key shape; every other provider joins through the
// provider-neutral shape.
export function accountKeyFor(platform: string, subject: string): string {
  return platform === "telegram" ? `${telegramPrefix}${subject}` : `${accountPrefix}${platform}#${subject}`;
}

export const accountItemKey = (platform: string, subject: string): TableKey =>
  ({ pk: accountKeyFor(platform, subject), sk: accountSort });

/** The provider and subject an account partition names, or null for another shape. */
export function parseAccountKey(partition: string): Readonly<{ provider: string; subject: string }> | null {
  if (partition.startsWith(telegramPrefix)) return { provider: "telegram", subject: partition.slice(telegramPrefix.length) };
  const match = /^ACCOUNT#([^#]+)#(.+)$/.exec(partition);
  return match === null ? null : { provider: match[1]!, subject: match[2]! };
}

// Index values (gsi1pk).
export const candidateIndex = {
  requested: "CANDIDATE#REQUESTED",
  observed: "CANDIDATE#OBSERVED",
  dismissed: "CANDIDATE#DISMISSED",
} as const;
export const activeIdentityIndex = "IDENTITY#ACTIVE";
/** An account linked to an identity is indexed under that identity's partition. */
export const identityIndex = identityPartition;
/** Login sessions are indexed by account. Telegram has no special case here. */
export const sessionAccountIndex = (provider: string, subject: string): string => `${accountPrefix}${provider}#${subject}`;

// Feature records that identity deletion finds by prefix.
export const oauthClientKey = (clientId: string): TableKey => ({ pk: `OAUTH#CLIENT#${clientId}`, sk: "CLIENT" });
export const oauthCredentialKey = (kind: "CODE" | "REFRESH", hash: string): TableKey => ({ pk: `OAUTH#${kind}#${hash}`, sk: kind });
export const oauthCredentialPrefix = (kind: "CODE" | "REFRESH"): string => `OAUTH#${kind}#`;

export const emailActionPrefix = "EMAIL_ACTION#";
export const emailActionKey = (tokenHash: string): TableKey => ({ pk: `${emailActionPrefix}${tokenHash}`, sk: "TOKEN" });

export const accessInvitationPrefix = "ACCESS_INVITATION#";
export const accessInvitationKey = (tokenHash: string): TableKey => ({ pk: `${accessInvitationPrefix}${tokenHash}`, sk: "TOKEN" });
export const accessInvitationProofSort = (provider: string, subject: string): string => `PROOF#${provider}#${subject}`;
export const accessInvitationProofKey = (tokenHash: string, provider: string, subject: string): TableKey =>
  ({ pk: `${accessInvitationPrefix}${tokenHash}`, sk: accessInvitationProofSort(provider, subject) });
export const createdAccessInvitationIndex = `${accessInvitationPrefix}CREATED`;

export const playerInvitationPrefix = "INVITATION#";
export const playerInvitationKey = (invitationId: string): TableKey => ({ pk: `${playerInvitationPrefix}${invitationId}`, sk: "EVENT" });
export const playerInvitationSenderIndex = (senderId: string, gameId: string, worldId: string): string =>
  `${playerInvitationPrefix}SENDER#${senderId}#GAME#${gameId}#WORLD#${worldId}`;

export const consolePrefix = "CONSOLE#";
export const consolePartition = (worldId: string): string => `${consolePrefix}${worldId}`;
/** One console command's record in its world's partition, ordered by when it was sent. */
export const consoleSortKey = (at: string, commandId: string): string => `${at}#${commandId}`;

export const downloadPrefix = "DOWNLOAD#";
export const downloadPartition = (worldId: string): string => `${downloadPrefix}${worldId}`;
/** One recorded download in its world's partition, ordered by when it was handed over. */
export const downloadSortKey = (at: string, downloadId: string): string => `${at}#${downloadId}`;

// Panel roles (ADR-0083).
export const roleKey = (roleId: string): TableKey => ({ pk: `ROLE#${roleId}`, sk: "DEFINITION" });
/** Every stored role is indexed under one value, so the list is one query. */
export const roleIndex = "ROLE";
export const accessDefaultsKey: TableKey = { pk: "SYSTEM", sk: "ACCESS_DEFAULTS" };

// A world's log reads and the owner's log assistant (ADR-0094).
export const worldLogPrefix = "WORLD_LOG#";
/** One log read in its world's partition: who asked, and the host that answers. */
export const worldLogKey = (worldId: string, readId: string): TableKey => ({ pk: `${worldLogPrefix}${worldId}`, sk: readId });

export const assistantAnswerPrefix = "ASSISTANT#";
/** One assistant answer in its world's partition. */
export const assistantAnswerKey = (worldId: string, answerId: string): TableKey => ({ pk: `${assistantAnswerPrefix}${worldId}`, sk: answerId });
/** How many questions one identity asked on one UTC day. */
export const assistantDailyUseKey = (identityId: string, day: string): TableKey => ({ pk: `ASSISTANT_USE#${identityId}`, sk: day });
/** What the deployment's assistant cost in one UTC month, in millionths of a dollar. */
export const assistantMonthlySpendKey = (month: string): TableKey => ({ pk: "ASSISTANT_SPEND", sk: month });
