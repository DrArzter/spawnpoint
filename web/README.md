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

Framework not yet chosen. Whatever it is, it must build to plain static files.

**Status:** empty. Populated in M4, download page before panel.
