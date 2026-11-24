import {
  type AvatarSource, CONTENT_TYPE, PROVIDER_PHOTO_LIMIT, UPLOAD_LIMIT, avatarKey, fetchablePhoto, identityPrefix, imageType, providerSource,
} from "../../access/avatar.ts";
import { type Identity } from "../../access/domain.ts";
import { profileKey } from "../../access/keys.ts";
import { accessTable, tableName } from "./access-store.ts";
import { isConditionFailure } from "./conditions.ts";
import { avatarObjects } from "./s3-avatars.ts";
import { type Response, response, parseJsonObject, errorResponse } from "./http.ts";

// Identity avatars (ADR-0084): copied once from a sign-in provider, or uploaded
// by the person; served through presigned links; deleted with the identity.

const LINK_SECONDS = 2 * 60 * 60;
const FETCH_TIMEOUT_MS = 2500;
const MAX_REDIRECTS = 3;

/**
 * A link to the picture, signed as of the start of the hour: the same link
 * within the hour, so the browser caches it, and valid for an hour after.
 */
export function avatarLink(key: string | null | undefined, now = new Date()): Promise<string | null> {
  if (typeof key !== "string" || key === "") return Promise.resolve(null);
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  return avatarObjects.link(key, LINK_SECONDS, hour);
}

async function store(identityId: string, bytes: Uint8Array): Promise<string | null> {
  const type = imageType(bytes);
  if (type === null) return null;
  const key = avatarKey(identityId, bytes, type);
  await avatarObjects.put(key, bytes, CONTENT_TYPE[type]);
  return key;
}

/** The provider photo's bytes, or null for anything that is not a small picture on a provider's host. */
async function fetchPhoto(url: string): Promise<Uint8Array | null> {
  let next = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!fetchablePhoto(next)) return null;
    const answer = await fetch(next, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const location = answer.headers.get("location");
    if (answer.status >= 300 && answer.status < 400 && location !== null) {
      next = new URL(location, next).toString();
      continue;
    }
    if (!answer.ok || Number(answer.headers.get("content-length") ?? 0) > PROVIDER_PHOTO_LIMIT) return null;
    const bytes = new Uint8Array(await answer.arrayBuffer());
    return bytes.length <= PROVIDER_PHOTO_LIMIT ? bytes : null;
  }
  return null;
}

/**
 * Copies a provider photo (see providerPhoto) when the identity has no avatar and has
 * not removed one. Never replaces an avatar; a failure leaves none, and the
 * next sign-in tries again. Returns the stored key, or null.
 */
export async function copyProviderAvatar(identity: Identity, photo: Readonly<{ url: string; provider: string }> | null): Promise<string | null> {
  const source = photo === null ? null : providerSource(photo.provider);
  if (photo === null || source === null || identity.avatarKey || identity.avatarRemoved) return null;
  try {
    const bytes = await fetchPhoto(photo.url);
    const key = bytes === null ? null : await store(identity.id, bytes);
    if (key === null) return null;
    await record(identity.id, key, source, "attribute_exists(pk) AND attribute_not_exists(avatar_key) AND attribute_not_exists(avatar_removed)");
    return key;
  } catch (error) {
    // Another sign-in wrote one first, or the provider did not answer: no avatar this time.
    if (!isConditionFailure(error)) console.warn("avatar_copy_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return null;
  }
}

async function record(identityId: string, key: string, source: AvatarSource, condition = "attribute_exists(pk)"): Promise<void> {
  await accessTable.update({
    TableName: tableName, Key: profileKey(identityId),
    UpdateExpression: "SET avatar_key = :key, avatar_source = :source, avatar_updated_at = :now REMOVE avatar_removed",
    ConditionExpression: condition,
    ExpressionAttributeValues: { ":key": key, ":source": source, ":now": new Date().toISOString() },
  });
}

async function deleteOthers(identityId: string, keep: string | null): Promise<number> {
  const stale = (await avatarObjects.keys(identityPrefix(identityId))).filter((key) => key !== keep);
  await avatarObjects.remove(stale);
  return stale.length;
}

function decode(image: unknown): Uint8Array | null {
  if (typeof image !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) return null;
  return new Uint8Array(Buffer.from(image, "base64"));
}

export async function uploadAvatar(identity: Identity, body: string | undefined): Promise<Response> {
  const parsed = parseJsonObject({ body });
  if (typeof parsed.image === "string" && parsed.image.length > Math.ceil(UPLOAD_LIMIT / 3) * 4) return errorResponse(400, "avatar_too_large");
  const bytes = decode(parsed.image);
  if (bytes === null || bytes.length === 0) return errorResponse(400, "invalid_avatar");
  if (bytes.length > UPLOAD_LIMIT) return errorResponse(400, "avatar_too_large");
  const key = await store(identity.id, bytes);
  if (key === null) return errorResponse(400, "invalid_avatar");
  await record(identity.id, key, "upload");
  await deleteOthers(identity.id, key);
  return response(200, { photoUrl: await avatarLink(key) });
}

export async function removeAvatar(identity: Identity): Promise<Response> {
  await accessTable.update({
    TableName: tableName, Key: profileKey(identity.id),
    UpdateExpression: "SET avatar_removed = :now REMOVE avatar_key, avatar_source, avatar_updated_at",
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":now": new Date().toISOString() },
  });
  await deleteOthers(identity.id, null);
  return response(200, { photoUrl: null });
}

/** Identity deletion: every picture the identity had. An identity keeps one, so one page lists them all. */
export async function deleteIdentityAvatars(identityId: string): Promise<number> {
  return deleteOthers(identityId, null);
}
