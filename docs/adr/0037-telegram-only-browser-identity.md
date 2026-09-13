# ADR-0037 — Telegram is the default and only browser identity provider

- Status: Superseded by [ADR-0045](0045-provider-neutral-login-sessions.md)
- Date: 2026-08-28
- Supersedes: [ADR-0018](0018-identity-and-sign-in.md), [ADR-0021](0021-sign-in-from-linked-chat-account.md), and [ADR-0035](0035-bootstrap-first-owner.md)

Telegram is the only required external identity. In an ordinary browser Spawnpoint verifies the signed Telegram Login Widget payload; inside the Mini App it verifies `initData`. Both are exchanged for the same short-lived, HMAC-signed Spawnpoint session, whose bearer token is kept in tab-scoped session storage. Authentication observes a Visitor; it never grants an application role. The configured Telegram ID may atomically claim the first Owner once, and every other Visitor waits for an Owner to approve the already-verified Telegram account.

Direct Telegram OIDC federation through Cognito was rejected after checking the live contracts: Telegram does not publish a UserInfo endpoint and documents `client_secret_basic`, while Cognito federation calls UserInfo and requires `client_secret_post`. The widget path depends only on the bot already required by the product; BotFather stores the allowed CloudFront domain and the existing bot token remains a SecureString in Parameter Store. Google, Discord and password login remain possible future adapters, not installation prerequisites.
