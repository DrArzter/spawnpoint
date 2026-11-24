# ADR-0087 — A chat runs the API's own routes

- Status: Accepted
- Date: 2026-11-24
- Milestone: M6
- Relates: [ADR-0006](0006-on-demand-start-and-idle-shutdown.md), [ADR-0054](0054-place-a-session-on-a-host-with-room.md), [ADR-0061](0061-connect-agents-through-oauth.md)

## Context

The panel and MCP start a world through one operation: the API's start route plans the session against the hosts,
running operations and world records, places it, and starts the lifecycle machine. The Telegram bot did not use it. It
started the machine itself, with its own single-flight check, for one host and one world named in its environment
(`SERVER_ID="minecraft"`, `INSTANCE_ID`, `WORLD_ID`). That is a second implementation of the same operation. It knew
nothing of placement, of other worlds on the host, or of the plan's refusals, and it held its own Step Functions grants.

## Decision

A chat surface asks the API to run one of its routes for a person, by a direct invocation of the API Lambda.

- The request (`contract/chat.ts`) names the login account the chat verified, the route key and its path parameters.
  `CHAT_ROUTES` lists the routes a chat may run; today only the world start.
- The API Lambda's entry tells a chat request from an HTTP event by its `kind` and by the absence of a request context,
  which API Gateway always sets. It then runs the same dispatcher over the chat routes: the account resolves to an
  identity, and the route's declared permission is checked, exactly as for a browser.
- Only an IAM principal with `lambda:InvokeFunction` on the API can make such a request. The bot role has that grant and
  no longer has `states:StartExecution` or `states:ListExecutions`.
- The world the bot starts stays deployment configuration (`bot_world` in `infra/terraform-bot`), since the bot has no
  world picker.

## Consequences

- One start operation for every surface. The bot gets placement, refusals and the operation id the panel shows.
- The bot trusts Telegram for who sent a message (its webhook secret, as before); the API trusts the bot role for the
  account it names. That is the same trust the bot already held when it wrote the requester into the start input.
- A new chat command adds its route key to `CHAT_ROUTES`; it needs no new grant and no orchestration in the bot.
- The bot's status, address and pack commands still read one configured host and world. They move to chat routes
  the same way when the bot learns more than one world.
