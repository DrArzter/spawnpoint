# Spawnpoint MCP

This is a thin stdio adapter over the production Spawnpoint control-plane API. It does not bypass the API: every tool runs as the connected Spawnpoint identity and keeps the same role and permission checks as the web console.

## Tools

- `get_profile`
- `get_control_plane`
- `get_host_metrics`
- `list_world_backups`
- `get_world_pack`
- `start_world`
- `stop_world`

The first version deliberately omits restore, wipe, purge, access management and release promotion. Those actions need a narrower confirmation contract before an agent receives them.

## Build

```sh
cd mcp
npm ci
npm run build
```

## Authentication

Set the API and panel origins, then choose one authentication method:

```sh
export SPAWNPOINT_API_URL=https://api.spawnpoint.drarzter.dev
export SPAWNPOINT_PANEL_URL=https://spawnpoint.drarzter.dev
export SPAWNPOINT_EMAIL=you@example.com
export SPAWNPOINT_PASSWORD='...'
```

The server signs in at startup, holds the returned HttpOnly session cookie only in memory, and signs in again after an expired session. Alternatively, set `SPAWNPOINT_SESSION_COOKIE` to the value of an existing `__Host-spawnpoint.session` cookie and omit email/password. A copied cookie cannot be renewed automatically.

Do not commit credentials or put literal secrets in an MCP configuration file. Inject them through the client or cloud environment's secret store.

## Claude Code

From the repository root:

```sh
claude mcp add --transport stdio spawnpoint -- node "$PWD/mcp/dist/server.js"
```

## Codex

Add the server once with the Codex CLI:

```sh
codex mcp add spawnpoint -- node "$PWD/mcp/dist/server.js"
codex mcp list
```

The same command works in a cloud development environment after the repository build step and the four environment variables are provided as secrets.

## Why stdio first

A public HTTPS `/mcp` endpoint for ChatGPT and hosted Codex should use OAuth 2.1 and verify authorization on every call. Spawnpoint currently has login sessions, not an OAuth authorization server. Stdio makes the control surface useful now without weakening that boundary or deploying a second privileged service. A remote transport can reuse these tool contracts when OAuth exists.
