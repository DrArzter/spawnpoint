# ADR-0094 — Read a world's log, and ask a model about it

- Status: Accepted
- Date: 2026-11-24
- Milestone: M6
- Relates: [ADR-0063](0063-run-console-commands-through-one-ssm-document.md), [ADR-0066](0066-keep-a-world-whitelist-on-its-record.md),
  [ADR-0071](0071-delete-an-identity-and-everything-that-names-it.md), [ADR-0092](0092-a-lambda-entry-is-its-composition-root.md)

## Context

When a world lags or crashes, the owners open a shell on the host to read the game's log. The panel shows the host's
own start lines (ADR-0063) but not the game's. A game log is long and hard to read for someone who did not write the
mods in it, so the owners also asked for help reading it, and only for the Owner level.

A game log names players and shows their network addresses. Both are personal data (UK GDPR): they must not leave the
host without need, and must not reach a model.

## Decision

- **Reading the log.** A fixed SSM document, `spawnpoint-world-log`, runs `server/scripts/world-log.sh` on the world's
  host, like the console (ADR-0063). Its parameters name only the world and the slot. The script prints at most the
  last 200 lines and 20,000 bytes of the game container's log. Exit 3 means the game has no container; exit 9 means
  the host's checkout has no script yet.
- **Redaction.** The API replaces IPv4 and IPv6 addresses, UUIDs and email addresses with tokens, and each player
  name with a stable `player-N`. It finds names by the join, leave and login lines games print, and from the world's
  whitelist. Chat text is removed. The log is redacted each time it is read and is never stored; the access table
  keeps who asked, for 24 hours.
- **Permission.** `log.read` is held by the Owner role and is grantable. MCP has `read_world_log` and
  `get_world_log_result` under it.
- **The assistant.** `assistant.use` is reserved: only the Owner role holds it, and no other role or direct grant can.
  The Owner chooses Claude Haiku or Claude Sonnet for each question and may add a question of up to 500 characters.
  The API checks the limits, records the question, and invokes a separate worker Lambda, `spawnpoint-assistant`,
  without waiting. Only the worker may call Bedrock, through the EU inference profiles, so the redacted log stays in
  the EU. The model gets the redacted log as data between tags and no tool.
- **Limits.** 20 questions per identity per UTC day, and a monthly cap for the deployment (USD 5 by default),
  estimated from the token counts Bedrock returns and the prices set in `assistant_prices`. The month is checked
  before the day is counted. The worker is never retried, so a failed answer is not paid for twice.
- **Off by default.** `assistant_enabled` is false. The repository variable `ASSISTANT_ENABLED` switches it on; a
  missing model id, price or cap keeps it off. While it is off, the API refuses questions and does not advertise the
  `assistant` capability, so the panel shows no assistant.

## Consequences

- An Owner can read a world's log and get an explanation in the panel, without a shell on the host.
- The redaction is best-effort: a game that names players in a way the patterns do not know, and that has no
  whitelist, can leave a name in the log. The model never sees an address. A per-game pattern in the game's manifest
  is the place to close such a gap.
- The monthly cap is an estimate. The prices are variables because Bedrock's EU prices can differ from the list
  prices. The defaults are the regional rates in the Marketplace offers accepted on 2026-11-24: Haiku 5.5 USD
  0.11/0.55 and Sonnet 5.5 USD 2.20/11 per million input/output tokens, 10% above the global rates. One answer may
  pass the cap, since the cap is checked before a question and the cost is known after it.
- The worker bundles its own AWS SDK, so Converse does not depend on the Lambda runtime's copy.
