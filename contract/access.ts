// What the access, session and profile routes send: who is signed in, the
// people and roles of the panel, invitations and a person's own settings.
import type { LoginProviderId } from "./login.ts";

/**
 * The account a session was signed in through. `provider` says which platform
 * vouches for it; the Telegram id stays a named field because the owner
 * bootstrap reads it, and an email account is described by its address.
 */
export type AccountProfile = Readonly<{
  provider: string;
  platformUserId: string;
  telegramId: string | null;
  username: string | null;
  email: string | null;
  photoUrl: string | null;
}>;

/** The signed-in identity as it may know itself: never its storage keys. */
export type SessionIdentity = Readonly<{
  id: string;
  displayName: string;
  roleId: string;
  directGrants: readonly string[];
}>;

export type SessionRole = Readonly<{
  id: string;
  name: string;
  description: string;
  permissions: readonly string[];
  /** The one role that holds the reserved permissions and must keep a holder. */
  protected: boolean;
}>;

/** The Owner's Telegram id is personal data that no member needs once the claim is made: it is always null here. */
export type OwnerBootstrapState =
  | Readonly<{ state: "unclaimed" }>
  | Readonly<{ state: "claimed"; ownerId: string; telegramId: string | null; claimedAt: string }>;

export type ActiveSession = Readonly<{
  state: "active";
  identity: SessionIdentity;
  /** What this deployment routes. A screen whose capability is absent is not offered at all. */
  capabilities: readonly string[];
  role: SessionRole | null;
  profile: AccountProfile;
  bootstrap: OwnerBootstrapState;
}>;

export type VisitorSession = Readonly<{
  state: "visitor";
  candidate: AccountProfile & Readonly<{
    displayName: string;
    status: "OBSERVED" | "REQUESTED" | "DISMISSED";
  }>;
}>;

/** `GET /me`: the caller and their role. */
export type Profile = Readonly<{ identity: SessionIdentity; role: SessionRole | null }>;

export type AccessCandidate = Readonly<{
  platform: string;
  platformUserId: string;
  displayName: string;
  username: string | null;
  email: string | null;
  photoUrl: string | null;
  status: "OBSERVED" | "REQUESTED";
  firstSeenAt: string;
  lastSeenAt: string;
  requestedAt: string | null;
}>;

/** One linked account. `handle` is the account's own name where it has one: a Telegram username, an email address. */
export type IdentityLink = Readonly<{ platform: string; value: string; handle: string | null; verified: boolean }>;

export type AccessIdentity = Readonly<{
  id: string;
  displayName: string;
  roleId: string;
  directGrants: readonly string[];
  /** Whether the caller may delete this identity; the backend's owner rules decide, so the web keeps no copy of them. */
  canDelete: boolean;
  /** The identity's avatar, else a photo from one of its linked accounts; null once removed. */
  photoUrl: string | null;
  links: readonly IdentityLink[];
}>;

/** An approved candidate, as the approval answers. */
export type ApprovedIdentity = Readonly<{ id: string; displayName: string; roleId: string; directGrants: readonly string[] }>;

/** A role's stored definition (ADR-0083), as a role write answers it. */
export type RoleDefinition = Readonly<{
  id: string;
  name: string;
  description: string;
  permissions: readonly string[];
  builtIn: boolean;
  /** The one role that holds the reserved permission and must keep a holder. */
  protected: boolean;
  version: number;
}>;

/** A role in the list, with what the caller may do with it. The web keeps no copy of these rules. */
export type AccessRole = RoleDefinition & Readonly<{
  /** How many active identities hold it; a held role cannot be deleted. */
  holders: number;
  /** Whether the caller may give this role. */
  assignable: boolean;
  /** The caller manages access, the role is not protected and the caller holds all its permissions. */
  editable: boolean;
  /** Editable, not built in, not held and not the default role. */
  deletable: boolean;
}>;

export type AccessPermission = Readonly<{
  id: string;
  group: string;
  label: string;
  description: string;
  /** Held only through the protected role. */
  reserved: boolean;
}>;

/** The role list with the permission catalogue and the role an approval gives when nobody picks one. */
export type AccessRoleDirectory = Readonly<{
  roles: readonly AccessRole[];
  permissions: readonly AccessPermission[];
  defaultRoleId: string;
}>;

export type AccessInvitationDelivery = "not_requested" | "pending" | "sent" | "failed";

export type AccessInvitation = Readonly<{
  id: string;
  status: "PENDING" | "USED" | "REVOKED" | "EXPIRED";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  delivery: AccessInvitationDelivery;
  deliveryEmail: string | null;
}>;

/** A new invitation; its link is shown once and never stored readable. */
export type IssuedAccessInvitation = Readonly<{
  id: string;
  url: string;
  createdAt: string;
  expiresAt: string;
  delivery: AccessInvitationDelivery;
}>;

/** Which notifications a person receives, by notification id. */
export type SubscriptionState = Readonly<Record<string, boolean>>;

/**
 * How the console looks for one person. `system` follows the device; the accent
 * is a hex colour the panel derives its blues from. Stored against the identity
 * rather than the browser, so a phone and a laptop agree.
 */
export type AppearancePreference = Readonly<{
  theme: "light" | "dark" | "system";
  accent: string;
}>;

/** Someone a player invitation can go to, and whether it would reach them. */
export type InvitationRecipient = Readonly<{
  id: string;
  displayName: string;
  delivery: "ready" | "notifications_off" | "bot_unavailable";
}>;

export type InvitationSummary = Readonly<{
  id: string;
  audience: "broadcast" | "direct";
  status: "READY" | "DELIVERING" | "DELIVERED" | "PARTIAL" | "FAILED" | "NO_RECIPIENTS" | "PUBLISH_FAILED";
  recipientCount: number | null;
  targetCount: number | null;
  successCount: number | null;
  failureCount: number | null;
  createdAt: string;
}>;

/** Which ways in this deployment offers. Read before there is a session. */
export type LoginOptions = Readonly<{
  providers: readonly LoginProviderId[];
  /** Providers through which an anonymous visitor may create a credential. */
  selfRegistration: readonly LoginProviderId[];
  emailActions: boolean;
}>;

export type LinkedLoginAccount = Readonly<{
  provider: string;
  subject: string;
  displayName: string | null;
  username: string | null;
  email: string | null;
  photoUrl: string | null;
  verified: boolean;
}>;

export type LinkedLoginAccounts = Readonly<{
  accounts: readonly LinkedLoginAccount[];
  /** Proof-based providers that this deployment can add to an existing identity. */
  linkableProviders: readonly LoginProviderId[];
  passwordManagementAvailable: boolean;
}>;
