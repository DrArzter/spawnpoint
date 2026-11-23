# ADR-0084 — An identity owns its avatar

- Status: Accepted
- Date: 2026-11-24
- Milestone: M6

## Context

A person's picture came from the account a session signed in with. A Telegram or Google account carries one; a
password account does not. So the same person had a picture after a Telegram sign-in and none after a password
sign-in, and the Access people list showed none at all. The owner wants the picture to belong to the person: taken
once from the first account that has one, kept, and changeable by the person.

## Decision

1. **One avatar per identity**, stored by Spawnpoint in a private S3 bucket, `spawnpoint-avatars-<account id>`, at
   `<identity id>/<sha256 of the image>.<jpg|png|webp>`. The profile records `avatar_key`, `avatar_source`
   (`telegram`, `google` or `upload`) and `avatar_updated_at`.
2. **Copied once.** When a session starts and the identity has no avatar, the API copies a provider photo: the
   signed-in account's, else the linked Telegram account's, else any linked Google account's. So a person who signs in
   with a password still gets the photo of a Telegram account they linked once. The copy is taken:
   - only over `https`, only from the providers' picture hosts (Telegram, Google), with no other redirect;
   - at most 512 KB, and only a JPEG, PNG or WebP by its first bytes;
   - recorded with a condition that no avatar exists, so two sign-ins cannot both write one.
   It never replaces an avatar. A failed copy leaves none, and the next sign-in tries again.
3. **The person changes it.** `POST /me/avatar` with `{ image }`, a base64 JPEG, PNG or WebP of at most 256 KB,
   replaces it (`avatar_source: upload`). The panel crops and scales the image to 256 × 256 before it sends it.
   `POST /me/avatar/delete` removes it, and records that the person removed it, so a later sign-in does not copy a
   provider photo back.
4. **Served by short-lived links.** `/session` and `GET /access/identities` carry `photoUrl`, a presigned S3 link. It
   is signed as of the start of the current hour and lasts two hours, so it stays the same within the hour and the
   browser can cache it. The bucket is never public. Until a sign-in has copied a picture, the access list shows the
   provider photo itself.
5. **Deleted with the identity.** Identity deletion removes every object under the identity's prefix.

## Consequences

- A person has the same picture however they sign in, and the Access list shows it.
- The picture is personal data that Spawnpoint now stores. It is visible to the person and to callers who may read
  the access list (`access.manage`). It leaves with the identity.
- The first sign-in after this change copies existing Telegram and Google pictures, one at a time, as people sign in.
- A provider picture that changes later is not followed. The person uploads a new one.
