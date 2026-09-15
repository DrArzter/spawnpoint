# web

The static site on S3 behind CloudFront is published at `https://spawnpoint.drarzter.dev/`; the provider hostname remains
available temporarily as a migration and diagnostic path. One React/Vite build serves two
entry points: Telegram's embedded **Mini App**, which authenticates with the signed `initData` Telegram supplies, and an
ordinary **browser panel**, which signs in through Telegram's Login Widget. Both exchange that proof for a short-lived
Spawnpoint session at the access API and hold no AWS credential of their own. See
[ADR-0037](../docs/adr/0037-telegram-only-browser-identity.md) and [ADR-0012](../docs/adr/0012-web-control-panel.md).

The bare root (`#/`) is the front door: a landing page in the console's own chrome that explains what Spawnpoint does,
shows a still of the Worlds page with example data, and carries **Sign in with Telegram** in the app bar plus a link
into the demo. Who sees what depends on the address and the session:

| Arriving at | With no session | With a session |
| --- | --- | --- |
| `#/` | The front door | Redirected to `#/worlds`, because a person holding a session asked for the console. This is how the Telegram Mini App opens every time, and how a browser that still holds its refresh cookie opens |
| `#/welcome` after signing out | The front door, reached by a full reload so the tab keeps nothing from the session | The same, if the session outlived the request meant to end it |
| `#/welcome` | The front door | The front door, on purpose. This is the address to send someone, and the one a signed-in person uses to read it again |
| Any console hash | The front door, with the hash left alone | The console |

A sign-in started on the front door ends in `#/worlds`. A signed-in person sees their avatar in the app bar instead of
the sign-in button, with Open the console, Profile and Sign out.

What a person sees is decided by their role, not by the client:

| Screen | Permission | What is there |
| --- | --- | --- |
| Worlds | `status.read` | The scoped game's session state and compute host, then every save as a row: availability, preset and release, current wipe, connection address with copy, Start and Stop. A save opens into its own page: Details, Wipes, Backups with **Restore** (`backup.read`, `backup.restore`), Releases with the client pack download (`connection.read`); **New wipe**, **Archive** and the typed-confirmation **Delete forever** sit in its actions menu (`world.manage`) |
| Metrics | `metrics.read` | Session metrics where the backend has them; an honest unavailable state otherwise |
| Console | `console.use` | An RCON console where the backend has it; an honest unavailable state otherwise |
| Releases | `release.read` | Per preset: build status, release history, source commit and **Create save** from a ready release (`world.manage`); the release pointer of every save |
| Access | `access.read`, `access.manage` | Visitors waiting for approval, identities and their roles, notification subscriptions, the one-time Owner bootstrap |
| Profile | any signed-in identity | Display details from Telegram and the identity's linked game and network accounts, read-only until linking flows exist |

The game is the console's scope: the picker in the app bar re-scopes Worlds, Metrics, Console and Releases, and the
hash carries it (`#/worlds/<game>`, `#/worlds/<game>/<world>`, `#/releases/<game>`), so a reload and a shared link land
on the same screen. `#/overview` stays an alias of `#/worlds`.

Constraints, unchanged:

- Static only. No server-side rendering, and nothing that needs a process running.
- The bucket stays private; CloudFront serves it.
- Addresses are composed, never configured: the strategy's host part plus the game's port, read from the control
  plane. A public world has no address between sessions and the panel shows none
  ([ADR-0033](../docs/adr/0033-connectivity-as-a-strategy.md)); ADR-0017's "show the hostname" rule went with it.
- Slow actions are operations with state. The UI polls and shows progress; it never blocks on a request.
- No control may imply data or an action the backend does not provide. See [PRODUCT.md](PRODUCT.md) and
  [DESIGN.md](DESIGN.md).
- Published pack URLs are presigned and short-lived; a new pack is a new release, never an overwrite.

**Status 2026-09-12: deployed.** The M4 cut that moved the panel to "afterwards" was reversed in practice: the Mini App
and browser panel went live on 2026-08-27 to 29 ([docs/aws-web-command-log.md](../docs/aws-web-command-log.md)) and
grew into the surface above. Designed here but not built: the self-serve one-time link code
([ADR-0019](../docs/adr/0019-account-linking.md)), a Discord account page, and a public pack site with history
([ADR-0013](../docs/adr/0013-modpack-distribution.md)).

## The panel story, re-tiered (2026-08-17)

> Kept as the reasoning of the day. Tier 3 is what was built; tiers 1 and 2 were not needed.

The expensive panel was the *public* one; the tiers below get the value without the cost, in order of arrival:

1. **The owner's localhost panel — the primary panel path.** `npm run panel` on the owner's machine: a local web app
   over the same control-plane calls the bot makes (StartExecution, pointer and S3 reads, SSM file peeks), using the
   owner's own `AWS_PROFILE` credential chain. Localhost is the authentication — the entire reason the panel was cut
   evaporates. Non-negotiable hardening, because a local server that spends money is a drive-by target: bind
   **127.0.0.1 only**, verify `Host`/`Origin` strictly, and require a startup-printed URL token (the Docker-API and
   Zoom localhost incidents are the cautionary tales).
2. **A session-scoped panel inside the overlay**, for players: lives and dies with the Compose session next to
   Grafana, behind the Traefik noted in [ADR-0033](../docs/adr/0033-connectivity-as-a-strategy.md). By construction it
   cannot *start* the server — it is down when the server is down.
3. **The public Telegram panel** ([ADR-0037](../docs/adr/0037-telegram-only-browser-identity.md)): now implemented as
   a static client with signed Telegram login and the same access directory as the bot. Authentication observes a
   visitor; Owner approval supplies the role.

**Panels render eggs.** The per-game adapter (see the placeholder in
[the ADR index](../docs/adr/README.md#decisions-still-to-record)) is a declaration with many consumers — the workflows
read its probes, the connectivity invariant reads its auth model, and the panel reads its *presentation*: which
metrics matter (MSPT for Minecraft, UPS for Factorio), which files are worth a look, and **which of this project's
blocks do not apply** (no pack block for Zomboid — the Workshop distributes; no whitelist block for Steam-auth games).
A game's page shows what that game cares about, never Minecraft's page with blanks.

Framework not yet chosen, and worth correcting one assumption in advance: **React with Vite was chosen** on
2026-08-27, and the assumption to correct stands: a React app builds to plain static files and needs no server, so it
works behind CloudFront like any other. What is excluded is server-side rendering and anything wanting a Node process —
a framework *mode*, not React itself. The shared primitives live in `src/components/ui`; a screen never invents its own
table, button or dialog ([DESIGN.md](DESIGN.md)).

## What the panel is actually for

> Status 2026-09-12: the backup list with restore, status, and access management are all built, in that order; the
> release review stays in Git.

Noted so it is not re-derived later. The admin jobs are not equally suited to a web page, and sorting them changes both
what gets built and when.

| Job | Panel? | Why |
| --- | --- | --- |
| **Review and approve a release** | **No longer** | This was the job that justified a panel. [ADR-0029](../docs/adr/0029-preview-environments.md) moved it into a pull request: GitHub renders the diff, a comment carries the resolved versions and a link to a preview server you can actually join, and merging is the approval. Nothing left to build here |
| **List backups and restore one** | Yes | A list with dangerous buttons, where picking the wrong row matters. Reads badly in chat |
| **Status and session history** | Optional | Useful, but the bots already answer it and that is where people ask |
| **Add or remove users** | Weak | Five people, changing maybe twice a year. A bot command or an edit to the parameter is proportionate; a form is not |
| **Add mods** | **No** | The mod list is a file, and it should stay one. Git gives review, history and a diff for free, and no form built here will beat editing a text file. See [ADR-0028](../docs/adr/0028-update-proposals.md) |

**What is left is smaller than it was.** This section used to argue for a read-only diff page as the panel's cheap
first 80%. [ADR-0029](../docs/adr/0029-preview-environments.md) took that job as well — the diff, the resolved versions
and the approval are all in the pull request — so the earliest useful screen is now the backup list, which is the only
row above that a page genuinely beats chat at.

That order was followed.

## Developing and deploying

Develop locally and build:

```bash
cd web
npm install
npm run dev      # dev server; open http://127.0.0.1:5173/?demo to run the console on the in-memory
                 # control plane in src/demo/ (?preview is the old name and still works;
                 # add &latency=800 to slow the fake calls)
npm run build    # static files in web/dist
```

### Demo mode

`?demo` answers every call from an in-memory control plane (`src/demo/`) instead of the access API. It works in a
production build as well as in dev, because the front door links to it: no token, no AWS call and no data that outlives
the tab. Starting and stopping a session, wiping, restoring, archiving, purging, creating a save, approving a Telegram
account and sending an invitation all change the state the console then reads back, and the transitions take a few
seconds so the operations table, the status rows and the polling behave the way they do against the real API.

**The mode picks a transport and nothing else.** `src/api/contract.ts` states what the panel asks of a backend;
`src/api/live.ts` and `src/demo/api.ts` both implement it, and `src/auth.ts` chooses between them in one expression.
Above that line there is no branch on the mode: the same screens, the same errors, the same sign-out and the same
navigation run in both. A demo session says so in its own data (`ActiveSession.demo`), which is what puts the Demo data
badge in the bar, and signing out is the ordinary sign-out. Reloading the tab resets the demo, because its state is the
module's.

This matters more than it looks. The first version branched on the mode inside the sign-out, so leaving the demo
reloaded the page and signing out of the real panel did not. The demo passed while the shipped path was broken.

Inside Telegram the app reads the client's theme through the official `telegram-web-app.js` bridge. Production is
deployed by `Deploy production` after a passing `Check` on `main` whenever `web/` or `scripts/deploy-web.sh` changed
([ADR-0043](../docs/adr/0043-deploy-production-from-reviewed-pull-requests.md)); `scripts/deploy-web.sh` also runs from
an owner workstation and skips the upload when the built `index.html` is unchanged.
