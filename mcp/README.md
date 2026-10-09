# Spawnpoint MCP

Spawnpoint exposes the same tool contract through the production remote MCP endpoint and a repository-local stdio adapter. Neither bypasses the API: every tool runs as the connected Spawnpoint identity and keeps the same role and permission checks as the web console.

## Tools

- `get_profile`
- `get_control_plane`
- `get_host_metrics`
- `list_world_backups`
- `get_world_pack`
- `get_release` — a release's server mods with their SHA-256 digests
- `get_release_mod_link` — a fifteen-minute link for one mod, by its digest (`release.read`)
- `get_backup_download_link` — a five-minute link for one backup archive, by its key; needs `backup.download` and is recorded
- `send_console_command` — one console command to a running world, as you; needs `console.use`, marked destructive so the client asks before each call, recorded with the client's name
- `get_console_result` — the answer to one command, by the id `send_console_command` returned
- `start_world`
- `stop_world`

The first version deliberately omits restore, wipe, purge, access management and release promotion. Those actions need a narrower confirmation contract before an agent receives them. The console relies on the connection being yours and on your client asking before each command; see the [ADR-0063 amendment](../docs/adr/0063-run-console-commands-through-one-ssm-document.md#amendment--the-console-through-mcp-2026-10-09).

## Build

```sh
cd mcp
npm ci
npm run build
```

## Connect — recommended

Add the remote server URL to an OAuth-capable MCP client:

```text
https://api.spawnpoint.drarzter.dev/mcp
```

For Codex, one setup command registers the remote resource and starts the browser flow:

```sh
codex mcp add spawnpoint \
  --url https://api.spawnpoint.drarzter.dev/mcp \
  --oauth-resource https://api.spawnpoint.drarzter.dev/mcp \
  --oauth-client-registration dcr
```

If the browser was closed before approval, restart only the login step:

```sh
codex mcp login spawnpoint --oauth-client-registration dcr --scopes spawnpoint.read,spawnpoint.operate
```

The client opens Spawnpoint in the browser. Sign in if needed, review the requested access, and press **Allow**. Spawnpoint returns to the client automatically; no password, cookie or environment variable is copied.

The connection receives short-lived, resource-bound access tokens and a rotating refresh credential. Its scopes only limit the connection further: Spawnpoint still checks the identity's live role and permissions for every tool call.

## Local stdio adapter

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

## History

The stdio adapter established the first tool contract. [ADR-0061](../docs/adr/0061-connect-agents-through-oauth.md) supersedes that local-first product path with browser-approved OAuth while retaining stdio for repository development.
