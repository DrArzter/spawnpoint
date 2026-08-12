# ADR-0013 — Distribute the client pack from S3 and CloudFront, as a launcher-importable pack

- Status: Proposed
- Date: 2026-08-11
- Milestone: M4

## Context

A player cannot join without the exact client mod set that matches the active release. The usual process is a
zip posted in a chat channel, with instructions to find the right folder and replace its contents. It goes
wrong constantly: an old file left behind, a partially applied update, a mismatch that shows up as an
unreadable login error.

Launchers solve installation, given a pack in a format they understand — the Modrinth `.mrpack` format, or the
CurseForge one. The launcher installs the loader, fetches the mods from upstream and creates an isolated profile, and
nothing is copied by hand.

**This group does not use one.** Mods are placed into the folder by hand, and the clients are not running the official
launcher — which is also the constraint behind `online-mode=false` in
[ADR-0022](0022-minecraft-account-as-linked-identity.md). So launcher-import is not the supported path here, however
much it would simplify things, and the archive is not a fallback but the primary artefact.

Redistribution licences differ per mod. A manifest that references upstream files avoids the question entirely for most
mods; a zip of binaries does not.

## Decision

Every release generates a client pack in a launcher-importable format, built from the same release definition
the server runs. See [ADR-0008](0008-versioned-mod-releases.md).

**The archive is the supported artefact**: a zip of the client-side mods and configs, applied by hand into the mods
folder. A manifest pack in a launcher format is published alongside it, at effectively no cost, for anybody who does
adopt a launcher later — but nothing depends on that happening.

Distribution is a static site on S3 behind CloudFront, sharing the distribution with the control panel:

- the current pack, at a stable URL,
- previous packs, by version,
- the changelog, from the release definitions,
- the server address and current status.

Access is by **short-lived signed link**, issued by the bot. Not for secrecy — nothing in a pack is secret — but for
cost, for the reasons in the next section.

## Egress exposure, and what to do about the public URL

Publishing at a public URL was decided here on the reasoning that nothing about a pack is secret and a login is friction
for no gain. That reasoning still holds for *secrecy*. It missed *cost*: at roughly $0.09 per GB, a 500 MB pack fetched
ten thousand times is five terabytes and around $450, and a forum hotlink or one person's broken download loop produces
that without anybody being malicious. See [docs/costs.md](../costs.md), where it is the largest unbounded exposure in the
design.

**Immutable content, ephemeral access.** The tempting fix — invalidate the old URL when a new release is published —
must not be taken. Old packs staying available is what lets a player pin to the previous release when a new one breaks
for them, and it is what the delta archive in [ADR-0028](0028-update-proposals.md) applies *from*. Versions are
immutable and permanent. If anything expires, it is the **link**, not the pack.

And the important arithmetic: **the exposure is not the archive's size, it is the URL being open.**

| Who fetches it | Volume | Cost |
| --- | --- | --- |
| Five players, 500 MB archive, two releases a month | ~5 GB | **under $0.50** |
| The same at ten releases a month | ~25 GB | ~$2.25 |
| A public URL, scraped or hotlinked ten thousand times | ~5 TB | ~$450 |

Serving binaries to this group costs pennies. Serving them to the internet does not. So the fix is access, not format.

### 1. Signed links, issued by the bot

A short-lived signed URL — valid for minutes, tied to whoever asked — caps any scrape at the length of one link rather
than the life of a release. That turns the only unbounded vector in the design back into a bounded one, and it costs
nothing to run.

The friction is genuinely small: a player asking the bot for the pack is already in the bot to start the server. See
[ADR-0016](0016-chat-integrations.md). This replaces the "the site is public" position taken earlier in this ADR, which
was decided on secrecy grounds without considering cost.

### 2. A manifest pack alongside, for whoever wants it

Published anyway, because it costs tens of kilobytes and it is generated from the same release. If anybody in the group
ever adopts a launcher that imports it, their downloads stop touching our egress entirely — the launcher fetches from
upstream instead. Worth having ready; not worth depending on.

### 3. Rate limiting, only if the first two prove insufficient

Keeps a URL open while capping the realistic case of one broken client. It carries a monthly charge of its own, which
against a bill of roughly six dollars is not a small addition, so it is the last resort rather than the first.

### Regardless: alarm on egress volume

An unusual amount of transfer is worth knowing about within hours, whichever of the above is in place. See
[ADR-0015](0015-observability-and-alerting.md).

## Consequences

**Good**

- Installation becomes an import, not a folder operation, which removes the main support burden.
- Server and client come from one source, so mismatch is designed out rather than warned about.
- Referencing upstream files keeps the licence question out of scope for most mods and keeps the artefact small.
- Old versions stay available, so a player can pin to the previous pack if a release breaks for them.
- Static hosting has almost no fixed cost and nothing to keep running.

**Bad, or risky**

- A launcher dependency. A player using a launcher that cannot import the chosen format is stuck.
- Upstream references can rot: a mod version can be withdrawn, and then the pack no longer installs.
- Two formats exist, and choosing one excludes some launchers.
- A public bucket serving files is a public bucket that can be scraped, and egress is billed.

**Mitigations**

- Publish one format properly, and provide a plain zip as a documented fallback for anyone whose launcher
  cannot import it.
- Cache the referenced binaries in the release store anyway, so a withdrawn upstream file does not break an
  existing release. This is also what the server needs for a fast boot.
- CloudFront in front of the bucket, with the bucket itself private, and a sane cache policy. Watch egress in
  the cost dashboard; at this scale it should be pennies.
- Version every pack URL, and never overwrite a published pack. Immutability is inherited from the release.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Zip file in a chat channel | Zero build cost, and the M0 behaviour. The problem this ADR exists to remove |
| Zip download from the site, applied by hand | Better than chat, but still relies on the player replacing the right folder correctly |
| Custom launcher or updater program | Best possible experience, and a genuinely interesting build. Far more work, needs signing and per-platform packaging, and duplicates what launchers already do well |
| Publish the pack on Modrinth or CurseForge | Free hosting and automatic updates in launchers, and worth doing eventually. Rejected as the primary route: it is public, it invites moderation and metadata work, and the pack is for one small group |
| A local sync tool the players run | Reads the release manifest, downloads what changed, removes what went. It is the delta archive done properly, and it would make updates painless. Costs a real tool to write, package for Windows and support for five people — and it asks them to run a program from a friend. Worth revisiting only if archives become genuinely painful |
| A third-party launcher that imports the manifest — Prism, MultiMC, ATLauncher | Free, and they work with offline accounts, so "no official launcher" does not rule them out. Not chosen because it is a change to how five people already play, which is their call rather than this document's. The manifest is published so the option stays open at any time |

## Open questions

- Which format is primary. `.mrpack` is the cleaner spec; CurseForge covers packs whose mods are not on
  Modrinth. Decide once the real mod list exists.
- Whether the pack build reuses `packwiz`, which already produces both formats from a manifest, rather than
  writing the exporter. A tool at the edge of the system, not the core, so reuse is reasonable here.
- Whether server-side-only mods are excluded automatically from the client pack, or marked by hand in the
  release definition.
