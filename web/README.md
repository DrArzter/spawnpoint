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

**Nothing here is on the critical path.** M4 was cut to one bot and a pack file at a stable URL, and the panel moved to
"afterwards, if the project earns it". See [docs/roadmap.md](../docs/roadmap.md).

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

**The useful part can come much earlier than the rest.** A read-only diff page is a static file generated when a
proposal is written — no login, no API, no identity machinery. That is the 80% of the panel's value with none of the
work that made M4 too big, and it can land with M3 rather than waiting. The approve button itself can stay in the bot,
where the owner already is.

So the order, when it comes: read-only diff page → backup list → anything else.

**Status:** empty. Populated in M4, download page before panel.
