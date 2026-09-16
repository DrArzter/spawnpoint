# ADR-0053 — Tell "not built yet" apart from "broken", in the transport

- Status: Proposed
- Date: 2026-09-16
- Milestone: M4
- Relates: [ADR-0012](0012-web-control-panel.md) (the panel this governs),
  [ADR-0036](0036-observed-visitors-and-owner-approved-access.md) (whose route table answers with its own `not_found`
  for anything it does not route)

## Context

The panel is built ahead of the API on purpose: a screen is designed, tried in the in-memory transport, and only then
does the route behind it get written. That order is good — it is how the demo caught a stale backup inventory and a
sign-out bug before either reached production — but it leaves a gap the panel cannot currently express.

Every call in the live transport turns a failed response into a plain `Error` carrying a sentence. A screen catches the
sentence and shows a banner with *Try again*. So a route that **does not exist yet** looks exactly like a route that
**is down**: the reader is told "Roles could not be loaded" and offered a retry that cannot succeed.

A second vocabulary grew up beside it. Three screens know they are incomplete and say so in hard-coded copy — the RCON
gateway, the CloudWatch tab and account linking each carry their own "not connected yet" banner, written by hand, in
the screen. Nothing connects those two ways of saying the same thing, and neither can be reused by the next screen that
lands before its API.

The information needed to tell the cases apart already exists. The API's dispatcher denies by default and answers an
unrouted request with its own body, `{"error": "not_found"}`, while a missing resource answers with a specific code
such as `unknown_materialized_world`. A route that was never deployed and a world that was never created are therefore
already distinguishable — the panel simply throws that distinction away.

## Decision

The live transport raises a **typed failure** instead of a bare error. Every failure carries one of three kinds:

| Kind | Raised when | What the panel shows |
| --- | --- | --- |
| `unavailable` | the dispatcher's own `not_found`, or `501` | a calm "not connected yet" state naming what will appear here |
| `forbidden` | `403` | what permission is missing, which some calls already said and all now can |
| `failed` | anything else | the existing banner with *Try again* |

The classification is deliberately narrow. Only the dispatcher's own not-found body counts as `unavailable`; a 404
carrying a resource error is a `failed` like any other, because the route answered.

**One state renders `unavailable` everywhere**, and the three hand-written "not connected yet" banners become uses of
it. A screen stops knowing whether it is a stub; it knows only what the transport told it.

**The session says what the deployment can do, so a dead page is not offered in the first place.** `GET /session`
returns a list of capability names, each derived from whether the API routes it — not from a list anybody maintains by
hand. A navigation entry appears when the role may use the screen **and** the deployment routes it. Asking and being
told "not connected yet" is the fallback for everything deeper than a menu entry; it is not the first line of defence.

The names are the contract and the route keys are the truth. `lambdas/test/access-api-routing.test.ts` already proves
the handler's table and the deployed API describe the same routes, and now also proves every capability points at a
route in that table, so a capability cannot advertise something API Gateway does not serve.

**The in-memory transport never raises `unavailable`.** It answers everything, which is what makes a screen fully
explorable in the demo before its API exists. This is not a second behaviour for the demo: it is the same screen, the
same handling, and a different answer from the transport — the rule that a mode may only choose a transport, never fork
behaviour, is unchanged.

## Consequences

**Good**

- A screen may ship before its route without lying about why it is empty, and without hard-coding its own incompleteness.
- A reader is not sent down a corridor that ends in a wall: an unroutable screen is missing from the navigation rather
  than present and apologetic.
- The demo keeps showing the whole screen, because the mock answers; the live panel says "not connected yet" from the
  same code.
- `forbidden` becomes uniform. Today two calls explain a missing permission and the rest say the request failed.
- A retry is only offered where retrying can work.

**Bad, or risky**

- A route that disappears in a bad deployment reads as "not built yet" rather than as an outage. The panel would be
  calm about a real regression.
- Three kinds is a vocabulary to keep honest. A call that classifies carelessly turns a fault into a shrug.
- The session now tells any signed-in person which parts of the deployment exist. That is not a secret, but it is more
  than it said before, and under [ADR-0050](0050-default-role-on-sign-in-and-elevation-requests.md) everybody who signs
  in is signed in.

**Mitigations**

- `lambdas/test/access-api-routing.test.ts` already asserts that the deployed route list and the handler's table
  describe the same routes, so a silently dropped route fails in CI rather than being discovered in the panel.
- `unavailable` is a visible state, never silence: the screen still says plainly that this part is not connected.
- The narrow rule — the dispatcher's own body, or 501 — keeps every resource-level 404 in `failed`.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Keep hard-coding "not connected yet" per screen | Works, and has to be written again for every screen that lands early, with wording that drifts each time |
| Treat every 404 as not-built | Turns a missing world into a missing feature and hides real faults |
| A capability list maintained by hand | Drifts the first time a route is renamed, and drifts silently, which is worse than not having it |
| Let the screen probe its own endpoint and decide | Same classification, written once per screen instead of once |

## Open questions

- Whether a screen reached by a link rather than the menu — a bookmark, a message from the bot — should also be
  suppressed, or whether landing on "not connected yet" is the right answer for an address somebody typed.
