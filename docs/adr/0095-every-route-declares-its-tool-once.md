# ADR-0095 — Every route declares its tool once

- Status: Accepted
- Date: 2026-11-24
- Milestone: M6
- Relates: [ADR-0061](0061-connect-agents-through-oauth.md), [ADR-0087](0087-a-chat-runs-the-apis-own-routes.md),
  [ADR-0094](0094-read-a-world-log-and-ask-a-model-about-it.md)

## Context

The owner's assistant (ADR-0094) is to do what a person can do in the panel: start and create worlds, build
releases, change the whitelist and config files, and the rest. MCP clients already act through a hand-written list of
fourteen tools in `access/mcp-tools.ts`, each with its own call in `mcp.ts` and another in the local adapter. A third
hand-written list for the assistant would drift from both, and a new feature would have to be added in four places.

## Decision

- **One catalogue.** A route's tool is declared beside the route, in its feature's `*-routes.ts`: a snake_case name, a
  title, a description, the input it takes beyond the path, and whether it is a read or a write. A write that loses
  something (a map, a release, a person's access) is marked destructive. `tool-catalogue.ts` derives each tool's input
  schema: the path's parameters, described once in `PATH_ARGUMENTS`, and the declared input.
- **Every route decides.** A route is a tool, or it says why it is none: a whole group with `withoutTools` (signing in,
  a person's own session and profile, OAuth, MCP itself, the assistant's own routes) or one route with `notATool`. A
  test fails on a route that does neither. A tool must have an identity's authority; a public or session route cannot
  be one.
- **A call is a request to its own route.** `runTool` turns the arguments into the route's event (the path's
  parameters, and the rest as a POST or PUT body or a GET or DELETE query) and passes the dispatcher's own gate
  (`identityRefusal`) before the handler. An argument the tool does not take is refused. The event names the agent the
  call came through, which only a call the API builds can set; the console records it.
- **Who sees which tools.** MCP offers the tools a feature marks `mcp`: the same fourteen as before, now derived, so
  widening what an outside client can do stays its own decision. The assistant gets every tool. The local adapter's
  `tools.generated.json` carries each tool's route, and the adapter makes every call from it.
- A console command's answer is now a route of its own, `GET .../console/{commandId}`, so every tool is a route.

## Consequences

- A new feature reaches MCP (if it chooses) and the assistant by declaring its tool once, next to its route.
- MCP's tool names, schemas and permissions are unchanged, except that `stop_world` now also takes `players`.
- The assistant's tool loop and its proposals for writes are the next decision (ADR-0094 is extended there).
