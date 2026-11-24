# contract

What the API sends and both sides check, written once (review X2, R24). The Lambdas and the web import these files.
They are plain TypeScript: no `node:` module, no AWS SDK, no DOM and no React, so both builds accept them. A test in
`lambdas/test/contract-purity.test.ts` enforces that. Imports between files here carry the `.ts` extension.

- `operations.ts`: how far a world operation has come, its steps and the host's own lines.
- `control-plane.ts`: the control-plane snapshot: games, worlds, presets, hosts and running operations.
- `backups.ts`: a world's backup inventory.
- `metrics.ts`: the metric ranges and a host's or a world's metrics.
- `access.ts`: sessions, people, roles, invitations and a person's own settings.
- `errors.ts`: every code the panel's API refuses with.
- `login.ts`: the browser login providers and the test that a value names one.
- `console.ts`: one console command as the API answers it.
- `settings.ts`: a game setting's definition and the rule that a value is valid for it.
