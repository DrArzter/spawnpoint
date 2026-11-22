# ADR-0079 — Pin an addon to a GitHub release asset

- Status: Accepted — builder side implemented; the config repository checks are a follow-up of the config owner
- Date: 2026-11-22
- Milestone: M6
- Amends: [ADR-0077](0077-pin-extra-mods-on-top-of-an-upstream-modpack.md) (the addons sources and "No other host is
  used")

## Context

ADR-0077 lets an addons entry name a CurseForge file or a Modrinth version. The group wants its own build of a mod in
a modpack world: a public fork of the unofficial Fabric port of Sophisticated Backpacks, with a fix. Neither source
fits a fork that is not on CurseForge or Modrinth.

Facts:

- The release builder holds the CurseForge key and may write `releases/*` and `presets/*`. It runs only reviewed
  scripts, and no source-supplied code runs in it ([ADR-0047](0047-normalize-preset-sources-before-building.md)).
  Building a mod there is refused.
- A JAR upload in the panel has no provenance and bypasses Git review
  ([ADR-0040](0040-reusable-presets-and-world-wipes.md), ADR-0077).
- GitHub serves a release asset at `github.com/<owner>/<repository>/releases/download/<tag>/<asset>`, with a
  redirect, and with no token for a public repository. An immutable release cannot change its assets or move its tag.
  GitHub Actions can attest the asset (`actions/attest`).
- The CodeBuild project has no VPC configuration. It already reaches CurseForge and the Modrinth CDN, so it also
  reaches GitHub. No Terraform change is needed (assumption; the first real build confirms it).
- The licence of the first fork is GPL-3.0 (the stricter claim). This ADR is not legal advice; see
  [Licence](#licence).

## Decision

**An addons entry may name `github_release` instead of `curseforge` or `modrinth`.** Exactly one source per entry.

```json
{
  "name": "Sophisticated Backpacks (Fabric port, Spawnpoint fix)",
  "side": "both",
  "github_release": {
    "repository": "DrArzter/SophisticatedBackpacks",
    "tag": "v1.20.1-3.23.4.5.110+sp.1",
    "asset": "sophisticatedbackpacks-1.20.1-3.23.4.5.110+sp.1.jar",
    "commit": "<40 lowercase hex>",
    "sha512": "<128 lowercase hex>",
    "bytes": 990000,
    "workflow": ".github/workflows/release.yml"
  }
}
```

| Field | Rule |
| --- | --- |
| `repository` | `owner/name`, and it must be in the owner allow-list (below) |
| `tag` | `^[A-Za-z0-9][A-Za-z0-9._+-]*$`; the tag is never reused |
| `asset` | A plain `.jar` file name, as for Modrinth (`+` is allowed) |
| `commit` | The full SHA that the tag points to; recorded in the lock |
| `sha512`, `bytes` | The pin, as for Modrinth |
| `workflow` | The path of the signing workflow in the same repository; read by the config repository's CI, not by the builder |

One entry per `repository` and `asset`, and one file name across all addons, as before.

**No repository list (amended 2026-11-22).** The first version kept an allow-list of repositories,
`GITHUB_RELEASE_REPOSITORIES`, in the builder, so that each new fork needed a Spawnpoint merge and an apply. It is
removed. A GitHub release pin is trusted the same way as a Modrinth or CurseForge pin, which never had a project list:

- The config repository is reviewed: a person merges the pin as a diff.
- The pin locks the exact file with its SHA-512 and size. The builder refuses any other bytes, so a replaced asset
  fails the build even without immutable releases.
- Before the merge, the config repository's CI checks that the release is published and immutable, that the asset
  matches the pin and the release digest, and that its build attestation names the pinned workflow, tag and commit on
  a GitHub-hosted runner.

A person who can change config `main` could already pin any Modrinth or CurseForge file, so the list in the builder
did not stop that person. It only made each new fork a Spawnpoint change.

**The builder (`resolve_github_release`) does five things.**

1. Check the shape.
2. Build the URL from the pin, with `+` as `%2B`. Never read a URL from the pin. Download only `asset`, so a
   `-sources.jar` never enters a release. No token and no GitHub API call.
3. Check the size, then the SHA-512, against the pin, before the file is moved or read for anything else. A mismatch
   refuses the build.
4. Write `source: {github_release: {repository, tag, commit}}` into the lock. The lock goes into the client pack's
   `spawnpoint-client-lock.json` as for the other sources.
5. Run C1 to C8 unchanged. C3 is a CurseForge check and does not apply.

After that nothing changes. A `both` or `server` addon joins `server.mods`; a `client` addon goes to `client-mods/`;
`both` and `client` addons go under the client pack's `overrides/mods/`. The release identity, `mod_index`, promotion
and backup work as they do for any addon.

**The trust anchor is the reviewed SHA-512 and size.** The builder does not verify the attestation or the
immutability. Two reasons: the pin already carries the reviewed decision into AWS, and unauthenticated GitHub API calls
from CodeBuild's shared addresses are limited to 60 an hour. The config repository's CI does these checks, with
`GITHUB_TOKEN`, on every pull request that changes an addons file (a required check):

1. The release JSON has `immutable == true`, `full_name` equal to `repository` (a rename cannot hide behind a
   redirect), an asset `digest` equal to the SHA-256 of the file, and an asset size equal to `bytes`.
2. The SHA-512 of the file equals the pin.
3. `gh attestation verify` with `--signer-workflow`, `--source-ref refs/tags/<tag>`, `--source-digest <commit>` and
   `--deny-self-hosted-runners`.
4. `gh release verify-asset`.

Those changes (schema, `validate-profiles.sh`, the CI job) belong to the config repository, `DrArzter/my-docker-minecraft-server-config`.
Until its `main` is protected with this check required, the SHA-512 pin still fixes the bytes, but nothing proves the
commit or the attestation.

### Licence

General guidance, not legal advice. A fork that Spawnpoint ships must keep its `LICENSE` and notices, state its
changes, and publish the complete source of each exact build: the public tag at `commit`, and a `-sources.jar` on the
release. Keep the tag and the release for as long as any Spawnpoint release carries the JAR. The first fork is treated
as GPL-3.0.

## Consequences

**Good**

- Provenance from commit to bytes, and the review stays in Git: the pin is a reviewed diff.
- No new secret, no Terraform change, no running cost, and no code of the fork runs in the builder.
- A fork and the Modrinth port can swap with the same mod id, so no items are lost if the fix changes no data format.
- C1 to C8, the client pack, promotion, backup and rollback work unchanged.

**Bad, or risky**

- A new host, `github.com`, and its redirect host serve JARs into the builder. Only the pinned SHA-512 limits this.
- The attestation is checked outside Spawnpoint. A direct push to config `main` skips that check.
- Any public repository can serve a pin. The config review and the attestation check decide, as for the other sources.
- The group maintains the fork and keeps its release for as long as a release uses it.

**Mitigations**

- Protect config `main` and require the CI check. Turn on immutable releases and tag protection in the fork.
- The download is bounded by the pinned size, the pinned SHA-512 and curl's time limit.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| The builder builds the mod from a commit | Gradle and Loom code would run in the privileged builder; conflicts with ADR-0047 |
| Upload a JAR in the panel | No provenance; bytes enter outside Git (ADR-0040, ADR-0077) |
| `vendored`: the JAR in the config repository | Fallback, not built. A binary diff shows nothing and every version stays in Git history |
| Modrinth unlisted or private project | Not a source: review and CDN access are not documented |
| An allow-list of repositories in the builder | Chosen first, removed on 2026-11-22: every new fork needed a Spawnpoint change, and it gave no protection that the config review and the SHA-512 pin do not |
| An allow-list by owner | Still a list to maintain; the config review already decides each pin |
| The builder verifies the attestation | Rate limit of unauthenticated API calls; the pin already carries the decision |
