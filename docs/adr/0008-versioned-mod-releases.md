# ADR-0008 — A mod set is an immutable, versioned release

- Status: Accepted
- Date: 2026-08-11
- Milestone: M3
- Amended by: [ADR-0030](0030-desired-and-active-release.md), which replaces the single live pointer with desired
  and active release state

## Context

The mod set changes often: a mod is added, one is removed because it crashes, versions are bumped when
the loader updates. Each change has to reach two places — the server and every player's client — and the
two must match exactly, or clients are rejected at login with an error nobody can diagnose.

Treated as "the current contents of a folder", this state has no history, no name to refer to, and no way
back. "It worked last Tuesday" is not recoverable, and "which pack are you on?" has no answer.

The same problem in ordinary software has a standard answer: build an immutable artefact, give it a
version, and deploy by pointing an environment at it. Rollback is repointing, not rebuilding.

## Decision

The unit of change is a **release**: an immutable, versioned bundle describing one playable
configuration. A release contains

- the Minecraft version and the mod loader version,
- the server-side mod list, each entry with a version and a content hash,
- the client-side mod list, same form,
- server and client config files,
- a changelog entry, and the identity of whoever cut the release.

### Artifact identity and descriptive metadata

The **SHA-256 digest and byte length identify a mod file**. Deployment verifies those values against the staged
payload; neither a filename, an embedded version nor a platform lookup may substitute for them. Two files with the
same display version but different SHA-256 digests are different artefacts and require a new release.

Best-effort metadata may be attached to an artefact for the UI, client/server reports and changelogs:

- one or more embedded mod IDs, names and declared versions from Forge, NeoForge, Fabric or Quilt metadata;
- homepage and source links;
- a CurseForge or Modrinth project ID and exact file ID;
- the method used to discover each field and any extraction warning.

This metadata is **descriptive, not authoritative**. A JAR may contain several mods, use
`${file.jarVersion}`, carry a non-SemVer version, put its version only in `MANIFEST.MF`, or have a filename that does
not match any embedded component. Therefore a generic `semver.coerce` comparison must not decide whether a release is
newer or whether client and server match. The release proposal explicitly chooses files; the lock manifest and hashes
say what those choices resolved to.

A platform fingerprint is useful only for enriching an unknown local JAR with its upstream identity. CurseForge's
fingerprint is its whitespace-normalised MurmurHash2 variant, not a cryptographic content hash and not an FNV hash of
ZIP entry names. Fingerprint lookup is optional and batched; an API outage or an unmatched private mod produces
missing metadata, not a failed otherwise reproducible release. API credentials come from the environment or a secret
store and are never written into the tool or manifest.

Releases are immutable once published. A mistake produces a new release, never an edit.

Exactly one release is **live** at a time, named by a mutable pointer. Deploying is moving the pointer;
rolling back is restoring the previous confirmed active release. The server reconciles itself against the desired release on boot and on
change. The client pack is generated from the same release, so server and client cannot drift apart.

Versioning: `MAJOR.MINOR` where MAJOR changes when the Minecraft or loader version changes and a world
migration may be needed, MINOR for any other mod set change.

## Consequences

**Good**

- "Which pack are you on?" has a precise answer, and it is checkable against a hash.
- Rollback is a pointer move, measured in seconds, and it is the same mechanism as a deploy, so it is
  exercised rather than theoretical.
- Server and client packs are generated from one input, which removes the main class of login failure.
- A changelog exists as a by-product, which is what players actually want to read.
- The concept is the transferable part: immutable artefact plus environment pointer is how real deploys
  work.

**Bad, or risky**

- Real overhead per change. "Just drop a mod in" is no longer possible, and a small group may resent that.
- Storage grows with every release kept, though mod files can be shared by hash across releases.
- Two things must stay consistent: the release definition and what is actually on the disk. A drifted
  server is worse than an obviously broken one.
- More machinery to build before the first mod update is easier than doing it by hand.

**Mitigations**

- Keep cutting a release to one command, or one upload plus one promote. If it is not nearly free, it will
  be bypassed.
- Reconcile on every boot and verify hashes after every sync, so drift is detected, reported and corrected
  rather than tolerated.
- Retain the last N releases and prune older ones, keeping any release the world has ever run on.
- A release that fails to start marks itself failed, and the pointer returns to the previous release
  automatically. See [ADR-0009](0009-s3-as-mod-source-of-truth.md).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| A mutable "current mods" folder | What most small servers do. Zero overhead, no history, no rollback, no way to name a configuration |
| Git repository of mod files | Real history and review, but git handles tens of megabytes of binaries badly, and it makes a mod swap a code change |
| Git repository of a manifest only, binaries fetched from upstream | Genuinely good, and close to what `packwiz` does. Depends on upstream availability at boot, which is a poor property for a server that must come up in three minutes. Worth revisiting as the source for building releases |
| Container image per mod set | Truly immutable and versioned, but an image build and push per mod change, and the world cannot live in the image |
| CurseForge or Modrinth pack format as the internal source of truth | Standard, and the right thing to *export*. Too constraining as the internal model, since server-side and client-side sets differ. See [ADR-0013](0013-modpack-distribution.md) |

## What the current setup already does, and where it falls short

The owner's working config resolves mods from a list of 111 CurseForge project URLs
(<https://github.com/DrArzter/my-docker-minecraft-server-config>). Worth recognising: **it is already a manifest rather
than a folder of binaries**, which is the shape this ADR argues for. The habit exists; what is missing is a record of
what the manifest resolved to.

**A correction to an earlier version of this section**, which claimed two boots of the same config could produce two
different servers. That is wrong. The image keeps downloaded mods in the data volume and does not wipe them unless told
to — `REMOVE_OLD_MODS` defaults to false — so once resolved, the set stays put. Boot does not re-resolve from scratch,
and the availability of CurseForge is not a per-boot dependency. It is also a large service with good uptime, so
availability was the weakest argument available and should not have been the one made.

The real gap is narrower, and this design is what creates it:

1. **The mod set exists only on that disk, and nothing records which versions it is.** Today that is harmless, because
   the disk persists. This project deliberately makes the instance disposable and rebuilds it — see
   [ADR-0027](0027-spot-request-shape.md) — which converts "resolved once, years ago" into "resolved fresh on every
   rebuild". Unpinned URLs then resolve to whatever is newest at that moment, which may be a different and broken
   configuration, and there is no way back to the one that worked. **The current setup is safe precisely because it does
   the thing this design gives up.**
2. **A withdrawn upstream file is unrecoverable.** Authors do delete versions from CurseForge. This argument does not
   depend on uptime at all, and it is the one that justifies caching binaries by hash rather than referencing them.
3. **Players still need a matching client set**, and that cannot come off the server's disk. With the server frozen and
   undocumented, there is nothing to generate a client pack *from*. This is now the strongest argument for the release
   model, rather than server reproducibility.

The migration is small. Resolve the 111 URLs once, record the file identifiers and hashes, cache the binaries: that is
release 1.0. The existing list becomes the input to the first release rather than something to be replaced.

## Open questions

- Whether mod binaries are stored per release or content-addressed by hash and shared. Content-addressed
  is better and slightly more work; decide in M3.
- Whether config files are part of the release or managed separately. Currently part of it, since a
  config change can break a client just as a mod can.
- How a world migration is recorded when a MAJOR release requires one.
