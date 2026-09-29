# ADR-0060 — Expose the control plane through a local MCP adapter first

- Status: Accepted
- Date: 2026-09-29
- Milestone: M4
- Relates: [ADR-0012](0012-web-control-panel.md), [ADR-0045](0045-provider-neutral-login-sessions.md)

## Context

Codex, Claude Code and other MCP clients should be able to inspect and operate Spawnpoint without scraping the web console. The control-plane HTTP API already owns authorization and operations. Spawnpoint has revocable login sessions, but it is not an OAuth authorization server; presenting those browser cookies as OAuth would create a second, misleading authentication contract.

## Decision

Spawnpoint first ships a repository-local stdio MCP adapter over the existing HTTP API. It authenticates through an enabled login provider, holds the resulting session only in memory, exposes a small set of read and reversible session tools, and relies on the API's existing role permissions for every call. Consequential lifecycle and access-management tools stay absent until they have explicit confirmation contracts.

A future public streamable-HTTP `/mcp` endpoint will reuse the tool contracts but must implement OAuth 2.1 resource metadata, token validation and per-tool scopes before hosted clients can use it.

## Consequences

- Local and cloud development agents can control Spawnpoint now with no second privileged backend.
- The MCP surface cannot drift into a second authorization system because it has no direct AWS or DynamoDB access.
- A development environment must receive Spawnpoint credentials through its secret store, and password-backed sessions make the first version unsuitable for public plugin distribution.
- Hosted ChatGPT connections remain deferred until OAuth exists.
