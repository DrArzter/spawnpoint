# contract

What the API sends and both sides check, written once (review X2, R24). The Lambdas and the web import these files.
They are plain TypeScript: no `node:` module, no AWS SDK, no DOM and no React, so both builds accept them. A test in
`lambdas/test/contract-purity.test.ts` enforces that. Imports between files here carry the `.ts` extension.

- `operations.ts`: how far a world operation has come, its steps and the host's own lines.
- `metrics.ts`: the metric ranges and the shape of a metric series.
- `console.ts`: one console command as the API answers it.
- `settings.ts`: a game setting's definition and the rule that a value is valid for it.
