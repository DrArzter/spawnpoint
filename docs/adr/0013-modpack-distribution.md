# ADR-0013 — Distribute the client pack from S3 and CloudFront, as a launcher-importable pack

- Status: Proposed
- Date: 2026-08-11
- Milestone: M4

## Context

A player cannot join without the exact client mod set that matches the live release. The usual process is a
zip posted in a chat channel, with instructions to find the right folder and replace its contents. It goes
wrong constantly: an old file left behind, a partially applied update, a mismatch that shows up as an
unreadable login error.

Modern launchers already solve installation. Given a pack in a format they understand — the Modrinth `.mrpack`
format, or the CurseForge pack format — a launcher installs the right loader, downloads the mods from their
upstream sources, and creates an isolated profile. Nothing is copied by hand.

Redistribution licences differ per mod. A manifest that references upstream files avoids the question
entirely for most mods; a zip of binaries does not.

## Decision

Every release generates a client pack in a launcher-importable format, built from the same release definition
the server runs. See [ADR-0008](0008-versioned-mod-releases.md).

The pack references mods by upstream project, version and hash wherever possible, and embeds only the files
that cannot be referenced — configs, and any mod whose licence permits redistribution and which has no stable
upstream.

Distribution is a static site on S3 behind CloudFront, sharing the distribution with the control panel:

- the current pack, at a stable URL,
- previous packs, by version,
- the changelog, from the release definitions,
- the server address and current status.

The site is public. Nothing on it is secret, and requiring a login to download a pack is friction for no gain.

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
| A local sync script the players run | Cheap to write, but asks players to run a script from a friend, which is a bad habit to teach |

## Open questions

- Which format is primary. `.mrpack` is the cleaner spec; CurseForge covers packs whose mods are not on
  Modrinth. Decide once the real mod list exists.
- Whether the pack build reuses `packwiz`, which already produces both formats from a manifest, rather than
  writing the exporter. A tool at the edge of the system, not the core, so reuse is reasonable here.
- Whether server-side-only mods are excluded automatically from the client pack, or marked by hand in the
  release definition.
