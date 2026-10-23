# HTTP API modules

`../access-api.ts` is the stable Lambda entry and composition root, not a place
for feature logic. This split does not introduce new Lambdas, URLs, or services.

## Ownership

Each `*-routes.ts` owns one functional area's HTTP paths and declares authority
with `publicRoute`, `sessionRoute`, `identityRoute`, or `permissionRoute`.
Its neighboring feature module implements the requests. Authentication,
access administration, access invitations, profile, control plane, worlds,
metrics, console, releases, backups, player invitations, OAuth, and MCP have
separate route groups.

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

`http.ts` owns transport types and response/body/cookie helpers.
`identity-store.ts` owns account keys, account observation and identity lookup;
`access-store.ts` owns the access table connection. Login credentials and login
sessions are separate adapters. Domain decisions remain in `access/`,
`domain/`, and `control-plane/`; do not move them into route declarations.

## Changing a feature

1. Add or change its handler and its route group. Do not add a local auth gate.
2. Keep API Gateway's route list and Lambda environment in Terraform in sync.
3. If adding a route group, compose it once in `route-table.ts`.
4. Test the feature directly, plus the dispatcher when changing authority.
5. Run the Lambda tests, typecheck and build. Routing tests compare declared
   authority and capabilities with deployed paths; module-boundary tests reject
   cycles and reverse dependencies.

The entry retains the existing `routes`, `deployedCapabilities`, and
`restorableRelease` exports for compatibility. New feature tests should import
the owning module rather than loading the whole API.
