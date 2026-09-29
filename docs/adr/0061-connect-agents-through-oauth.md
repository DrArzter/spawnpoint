# ADR-0061 — Connect agents through OAuth

- Status: Accepted
- Date: 2026-09-29
- Milestone: M4
- Supersedes: [ADR-0060](0060-expose-control-plane-through-a-local-mcp-adapter.md)
- Relates: [ADR-0045](0045-provider-neutral-login-sessions.md)

## Context

The local stdio adapter proved the MCP tool contract, but made every user copy a password, cookie or environment variables into each agent environment. That is the opposite of the connection flow people expect from hosted tools, and it spreads a login credential into clients that need only delegated access.

## Decision

Expose Spawnpoint as a remote streamable-HTTP MCP resource and make an Agent connection through OAuth authorization code flow with PKCE S256. The browser reuses the existing provider-neutral Login session, shows the requesting client and scopes, and returns a one-time code to the client. Access tokens are short-lived and audience-bound; refresh credentials rotate. OAuth scopes cap the tools a client may request, while the connected Identity's current role and permissions remain authoritative for every tool call.

The authorization server and resource server live on the existing access API. Public clients register redirect URIs dynamically and hold no client secret. Spawnpoint login credentials and browser cookies never leave Spawnpoint.

## Consequences

- Codex and other OAuth-capable MCP clients connect through a browser redirect instead of copied secrets.
- Removing a role or permission immediately narrows an existing connection even before its token expires.
- The access table gains expiring authorization codes and rotating refresh credentials; their values are stored only as hashes.
- The repository-local stdio adapter remains useful for development, but is no longer the primary product path.
