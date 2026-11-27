# ADR-0107 — Feature flags in Parameter Store

- Status: Accepted
- Date: 2026-11-27
- Milestone: M6
- Amends: [ADR-0106](0106-a-skin-can-be-switched-off.md) — which skins a session may wear;
  [ADR-0094](0094-read-a-world-log-and-ask-a-model-about-it.md) — the assistant's switch is merged with the flags

## Context

The owner wants to switch a feature off, or narrow the panel's skins, without a new release. Today a capability is off
only when its route is not deployed or, for the assistant, when Terraform sets `ASSISTANT_ENABLED` (ADR-0094). A skin
is off only when the build leaves it out (ADR-0106). Both need a deploy.

## Decision

**One SSM `String` parameter, `/spawnpoint/flags`, holds the flags as JSON.** The access-api Terraform root creates it
with the value `{}` and ignores later changes to the value, so a deploy never overwrites what the owner set. The API
Lambda reads it with `ssm:GetParameter` on that one parameter, named by `FEATURE_FLAGS_PARAMETER`.

```json
{"off": ["assistant", "worldLog"], "skins": ["console"]}
```

- `off` lists capability names: the keys of `capabilityRoutes` in `lambdas/src/handlers/api/capabilities.ts`.
- `skins` lists the skin ids the panel may wear.
- Both are optional. A name or a key the API does not know is ignored, with one warning in the log.

**The API reads the flags through a port.** `FeatureFlags` (`handlers/api/feature-flags.ts`) is the port, and
`ssm-feature-flags.ts` is the SSM adapter. The Lambda entry constructs it and hands it to the route table
(`apiDeployment`).

- **Cache.** One read serves a container for 60 seconds. A change reaches every container within about a minute.
- **The session.** `GET /session` advertises the capabilities less the flags' `off` and the assistant's own switch
  (ADR-0094). It also carries `skins`: the flags' list, or `null` when the flags do not set it.
- **Enforcement.** The shared dispatcher refuses a route of a capability that is off with 404 `feature_off`. It refuses
  only a caller who would otherwise reach the route, so a caller without a session still gets 401. A tool call
  (MCP, the assistant) is refused in the same way, and MCP does not list the tool. A capability whose routes are a
  group of their own is refused whole: `consoleGateway` (the console routes), `configFiles` (world config files),
  `worldLog` (the world log) and `assistant` (the assistant and its conversations). Any other capability loses only
  the route that `capabilityRoutes` names. For example, `backups` refuses the backups list, but not the backup
  download.
- **The panel.** The capabilities already hide what is off. For skins, the build's enabled list (ADR-0106, and
  `VITE_ENABLED_SKINS`) is the set of skins in the bundle. When the session carries `skins`, the panel wears only
  skins in both lists. A flag list without `console`, the default skin, is ignored and logged in the browser console.
  If the remembered skin is not allowed, the panel wears the default skin in place, without a reload, and keeps the
  stored choice. The profile's Look chooser offers the same list. Tests and the UI gate still follow the build's
  list.

**Everything fails open.**

| What happens | Effect |
| --- | --- |
| The parameter holds invalid JSON or a wrong shape | The API keeps the last good value; before one, everything is on. It logs an error. |
| The read fails (for example, access denied) | Same as invalid JSON. The next read is after the cache time. |
| No parameter name in the environment | Everything is on. |
| `skins` leaves out the default skin | The panel ignores it and uses the build's list. |

## How to switch something off

```bash
aws ssm put-parameter --name /spawnpoint/flags --overwrite --type String --value '{"off":["worldLog"]}'
```

To switch everything on again, set the value to `{}`. The change applies within about a minute. A panel that is
already open notices it at its next session load.

## Consequences

- A capability can be switched off and on again without a release.
- A flag cannot switch a feature on that the deployment does not route, and it cannot add a skin that the build left
  out.
- A capability that shares its route group refuses only its named route. Its other routes stay open until the group
  is split.

## Alternatives considered

- **AWS AppConfig.** It has rollouts and validators, but it costs another service and another deploy pipeline for a
  list of a few names.
- **A record in the access table.** It needs a write path and a screen. The owner already uses the AWS console and the
  CLI for operational settings.
