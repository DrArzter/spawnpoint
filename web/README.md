# web

The static site on S3 behind CloudFront. Two things, one distribution:

**Control panel** — a client of the control-plane API, with no rules of its own. Server status and player
count, a Start button, release history with changelogs, backup list, and the owner-only actions. Sign-in
through Cognito with Google. See [ADR-0012](../docs/adr/0012-web-control-panel.md) and
[ADR-0018](../docs/adr/0018-identity-and-sign-in.md).

**Account page** — "Connect Telegram" and "Connect Discord". Shows a one-time code to send to the bot, lists
linked accounts, and allows unlinking. The code is displayed here only and never sent through chat. Once
linked, a bot-issued link signs the same identity in, so this page is also what enables chat sign-in. See
[ADR-0019](../docs/adr/0019-account-linking.md) and [ADR-0021](../docs/adr/0021-sign-in-from-linked-chat-account.md).

**Pack downloads** — the current client pack at a stable URL, previous versions kept, plus the changelog and
the server hostname. Public: nothing here is secret, and a login to download a pack is friction for no gain.
See [ADR-0013](../docs/adr/0013-modpack-distribution.md).

Constraints:

- Static only. No server-side rendering, and nothing that needs a process running.
- The bucket stays private; CloudFront serves it.
- Show the hostname, never a raw IP address — addresses here expire. See [ADR-0017](../docs/adr/0017-stable-server-address.md).
- Slow actions are operations with state. The UI polls and shows progress; it never blocks on a request.
- Published pack URLs are immutable. A new pack is a new version, never an overwrite.

**Nothing here is on the critical path.** M4 was cut to one bot and a pack file behind bot-issued links, and the panel
moved to "afterwards, if the project earns it". See [docs/roadmap.md](../docs/roadmap.md).

## The panel story, re-tiered (2026-08-17)

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
3. **The public Cognito panel** ([ADR-0012](../docs/adr/0012-web-control-panel.md),
   [ADR-0018](../docs/adr/0018-identity-and-sign-in.md)): deferred further still — it now has to beat both tiers
   above, not just the bot.

**Panels render eggs.** The per-game adapter (see the placeholder in
[the ADR index](../docs/adr/README.md#decisions-still-to-record)) is a declaration with many consumers — the workflows
read its probes, the connectivity invariant reads its auth model, and the panel reads its *presentation*: which
metrics matter (MSPT for Minecraft, UPS for Factorio), which files are worth a look, and **which of this project's
blocks do not apply** (no pack block for Zomboid — the Workshop distributes; no whitelist block for Steam-auth games).
A game's page shows what that game cares about, never Minecraft's page with blanks.

Framework not yet chosen, and worth correcting one assumption in advance: **React is not excluded by anything in this
design.** A React app builds to plain static files and needs no server, so it works behind CloudFront exactly like any
other. What is excluded is server-side rendering and anything wanting a Node process — that is a framework *mode*, not
React itself.

When the panel is actually built, the shortlist, in order:

| Option | Why |
| --- | --- |
| No framework | Four screens — status, a start button, a release list, a backup list. Plain HTML with a little JavaScript genuinely covers it, and it is the honest starting point |
| Preact | React's API in a few kilobytes, near drop-in. The closest thing to React that is not React |
| Solid | JSX and React-like ergonomics with signals instead of a virtual DOM. A different mental model, and a better one for a page that mostly polls an operation |

Decide when a screen actually hurts, not before.

## What the panel is actually for

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

So the order, when it comes: backup list → status → anything else.

## Telegram Mini App preview

The first panel slice is a read-only React/Vite Mini App shell. It deliberately
uses mock data and has no AWS action wired, so visual work cannot accidentally
start a billed session:

```bash
cd web
npm install
npm run dev
```

Open the printed localhost URL in a browser. Outside Telegram it identifies
itself as `LOCAL PREVIEW`; inside Telegram it reads the client's theme through
the official `telegram-web-app.js` bridge. `npm run build` produces static
files in `web/dist`, suitable for the eventual private S3 + CloudFront site.

Next slices: validate Telegram `initData` in the backend, expose a read-only
status endpoint, deploy the static build, then add the bot's `web_app` button.
No mutating action is connected before authenticated status works end to end.
