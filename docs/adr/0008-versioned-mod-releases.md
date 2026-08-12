# ADR-0008 — A mod set is an immutable, versioned release

- Status: Accepted
- Date: 2026-08-11
- Milestone: M3

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

Releases are immutable once published. A mistake produces a new release, never an edit.

Exactly one release is **live** at a time, named by a mutable pointer. Deploying is moving the pointer;
rolling back is moving it back. The server reconciles itself against the live release on boot and on
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

The owner's working config resolves mods at container start from a list of 111 CurseForge project URLs
(<https://github.com/DrArzter/my-docker-minecraft-server-config>). That is worth recognising: **it is already a
manifest rather than a folder of binaries**, which is the shape this ADR argues for. The habit exists; what is missing
is the immutability.

Two gaps, both concrete:

1. **Nothing is pinned.** All 111 entries are bare project URLs with no file identifier, so each boot resolves to
   whatever the latest compatible file is at that moment. The image tag is `stable`, which also moves. So two boots of
   the same configuration can produce two different servers, and a break cannot be attributed to either source. This is
   not a hypothetical risk — it is the current behaviour, and it is precisely what a release version fixes.
2. **Booting depends on CurseForge being reachable.** This ADR requires the opposite: a server that comes up in three
   minutes without a third party in the path. A release store that caches the resolved binaries by hash removes the
   dependency and makes the pin real at the same time.

So the migration is smaller than it looks. Resolve the 111 URLs once, record the file identifiers and hashes, cache the
binaries, and that is release 1.0. The existing list becomes the input to the first release rather than something to be
replaced.

## Open questions

- Whether mod binaries are stored per release or content-addressed by hash and shared. Content-addressed
  is better and slightly more work; decide in M3.
- Whether config files are part of the release or managed separately. Currently part of it, since a
  config change can break a client just as a mod can.
- How a world migration is recorded when a MAJOR release requires one.
