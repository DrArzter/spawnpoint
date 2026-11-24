# HTTP API modules

`../access-api.ts` is the stable Lambda entry and composition root, not a place
for feature logic. This split does not introduce new Lambdas, URLs, or services.

## Ownership

Each `*-routes.ts` owns one functional area's HTTP paths and declares authority
with `publicRoute`, `sessionRoute`, `identityRoute`, or `permissionRoute`.
Its neighboring feature module implements the requests. Authentication,
session, profile, access administration, access invitations, control plane,
worlds, operations, metrics, releases, backups, release promotion, console,
player invitations, OAuth, and MCP have separate route groups: sixteen, in the
order `route-table.ts` composes them.

`route-table.ts` composes those groups and rejects duplicate route keys.
`capabilities.ts` derives advertised capabilities from the composed routes;
the session route receives a callback rather than importing the composition
root. Keep dependencies directed: feature handlers never import route groups,
`route-table.ts`, or the Lambda entry.

`dispatcher.ts` is the single HTTP authentication/authorization boundary. It
checks cookie origin, resolves a login principal and identity only when needed,
and checks the declared permission before calling a handler. Identity resolution
is injected so that this contract can be tested without AWS configuration.
Only payload-dependent escalations belong inside handlers, such as granting
owner access. MCP remains a distinct OAuth resource: it validates its own
audience, scopes, identity and tool permission, then reuses the same feature
operations as HTTP.

`http.ts` owns transport types and response/body/cookie helpers. It holds the
only JSON body parser, `parseJsonObject`. A body that is not one JSON object
throws `InvalidBodyError`, and the dispatcher answers 400 `invalid_json`.
`../../access/keys.ts` owns every access-table key and index value, and
`../../access/identity-creation.ts` the one new-identity transaction.
`identity-store.ts` owns account observation and identity lookup;
`access-store.ts` implements the access table's port (`access/table.ts`, ADR-0091); handlers call `accessTable`, never the SDK. Login credentials and login
sessions are separate adapters. Domain decisions remain in `access/`,
`domain/`, and `control-plane/`; do not move them into route declarations.

## Ports and wiring

A feature that needs a cloud API takes it as a port, the way the console does:
`console.ts` builds the feature from `ConsoleDependencies` (the gateway and the
record store are types in `control-plane/console.ts`), the adapters are
`control-plane/aws-ssm-console-gateway.ts` and `console-store.ts`, and
`console-wiring.ts` binds them once for the routes and MCP. Its tests use
in-memory fakes; only an adapter's own test fakes the SDK. The backups,
releases, world operations and promotion follow the same shape. The ports are
`ControlPlaneSources` (`read-model.ts`, adapter `aws.ts`), `WorldRecords`
(`world-records.ts`, adapter `aws-world-records.ts`), `SessionMachines`
(`session-machines.ts`, adapter `aws-session-machines.ts`), `ReleaseLinks`,
`BackupArchives` and the console's two. `test/module-boundaries.test.ts` lists
the files that still call the SDK directly; the access feature is most of them.

## Changing a feature

1. Add or change its handler and its route group. Do not add a local auth gate.
2. Keep API Gateway's route list and Lambda environment in Terraform in sync.
3. If adding a route group, compose it once in `route-table.ts`.
4. Test the feature directly, plus the dispatcher when changing authority.
5. Run the Lambda tests, typecheck and build. Routing tests compare declared
   authority and capabilities with deployed paths; module-boundary tests reject
   cycles and reverse dependencies.

The entry re-exports `routes` and `deployedCapabilities` from `route-table.ts`
for compatibility. New tests import the owning module, or `route-table.ts`,
rather than loading the whole API.
