# ADR-0108 — A game declares what its launch needs

- Status: Accepted
- Date: 2026-11-27
- Milestone: M6
- Builds on: [ADR-0088](0088-a-game-declares-its-facts-once.md) (a game declares its facts once; the platform never names one)

## Context

Project Zomboid failed three times on its first production starts, about ten minutes each. Each failure was a fact
the repository already knew, found only after a host was launched:

1. `ZOMBOID_RCON_PASSWORD` and `ZOMBOID_ADMIN_PASSWORD` were not in SSM under `/spawnpoint/host/env/`. The Compose
   file requires them with `${VAR:?...}`, so the start failed on the host. Palworld's `PALWORLD_ADMIN_PASSWORD` was
   missing the same way.
2. The admin name was empty (PR #345).
3. RCON was off on the first start, and the 600-second start deadline was too short (PR #347). The longer deadline
   was a constant in Zomboid's `game.sh`.

Zomboid's image was also the only one on a moving tag (`latest`).

A full acceptance run of every game was considered and declined as too much. What is wanted is that the facts which
broke these starts are declared once per game and checked before a host exists, the same way for every game.

## Decision

**Two manifest fields**, in `server/games/<id>/game.json`:

| Field | Meaning | Default |
| --- | --- | --- |
| `required_secrets` | The `.env` keys the game needs from `/spawnpoint/host/env/`. Required in every manifest; `[]` when none. | none |
| `start_timeout_seconds` | How long `start.sh` waits for the game to serve after `compose up`. A whole number, 60 to 3000. | 600 |

`load_game` exports `start_timeout_seconds` as `GAME_START_TIMEOUT_SECONDS`, and `start.sh` reads it.
`START_TIMEOUT_SECONDS` still overrides it for a test or an operator. The upper bound keeps a start inside the start
document's one hour (`spawnpoint-start-session`), which also restores and mounts the world. The Lambdas read both
fields through `game-modules.ts` and refuse a malformed manifest when the bundle loads.

**CI guards** (`server/tests/game-requirements-test.sh`, `lambdas/test/game-modules.test.ts`):

- A variable a game's Compose files require (`${VAR:?...}`) is in `required_secrets`, or a host script sets it
  (`SPAWNPOINT_FOOTPRINT_MEMORY_MIB`, `SPAWNPOINT_GAME_IMAGE`). A declared key is one the game reads, and is an
  `.env` key.
- Every image a session runs, and every image of the observability tier, is pinned by digest. Factorio's image is
  `${SPAWNPOINT_GAME_IMAGE}`: `game_prepare_runtime` takes it from a verified release and refuses it without
  `@sha256:`, so the test accepts that one expression for Factorio only.

**Zomboid's image is pinned** to `terule/pz-dedicated-server@sha256:f5e39eeb…ca9d55a`. Docker Hub shows `latest` was
last pushed on 2026-04-02 with that digest, so every production start since then pulled it. Pinning does not change
what a host runs today; it stops a new push changing it without a commit.

**The preflight.** Before the API starts a session (start, or a promotion that starts one), it reads the parameter
names under `/spawnpoint/host/env/` and refuses at once with `409 missing_game_secrets` and the missing keys when
any of the game's `required_secrets` is absent. It reads names only: `ssm:GetParametersByPath` on that path, without
decryption, so the API has no `kms:Decrypt` and never sees a value. The check is a port in the control plane with one
SSM adapter, and the panel shows the refusal from the message catalogue.

The API is the place, not the first workflow step: a refusal there reaches the person who pressed Start in the same
request, before an operation record, a placement or a host exists. A workflow step would show the same fact later as
a failed operation.

## Consequences

- A new game cannot reach `main` with a required variable nobody declared, or with an image on a moving tag.
- A missing secret costs one refused request, not a launched host and ten minutes.
- `GetParametersByPath` is allowed on one path only. `DescribeParameters` was not used: it cannot be limited to a
  path and would list every parameter in the account.
- The host-wide parameters (`RCON_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`, the buckets) stay in
  `scripts/check-fleet-readiness.sh`, which checks them before a deploy. A game lists only what it reads itself;
  Minecraft lists `RCON_PASSWORD` because its Compose file requires it.
- What is still not checked before a launch: a value that exists but is wrong, and a game that starts but does not
  answer. Those remain the start's own failures.
