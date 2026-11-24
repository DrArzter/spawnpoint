import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { attachmentDisposition, packAttachmentName, releaseModKey, type ReleaseLinks } from "./release-artifacts.ts";
import { objectKey, releasePackStorageKey } from "./release-objects.ts";

type ManifestReader = (gameId: string, presetId: string, release: string) => Promise<unknown>;

/** Presigned links into the release bucket. A file is named as the player should save it. */
export function s3ReleaseLinks(s3: S3Client, bucket: () => string, readManifest: ManifestReader): ReleaseLinks {
  return {
    // An objects-v1 release keeps its packs as objects named by digest, so the
    // attachment name is what tells a player which pack it is. A missing pack is
    // a normal answer: releases published before packs were part of publication have none.
    pack: async (gameId, presetId, release, pack, expiresIn) => {
      const key = releasePackStorageKey(await readManifest(gameId, presetId, release), gameId, presetId, release, pack);
      if (key === null) return null;
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
      } catch {
        return null;
      }
      return getSignedUrl(s3, new GetObjectCommand({
        Bucket: bucket(), Key: key, ResponseContentDisposition: attachmentDisposition(packAttachmentName(presetId, release, pack)),
      }), { expiresIn });
    },
    mod: (gameId, presetId, release, location, expiresIn, objectDigest) => getSignedUrl(s3, new GetObjectCommand({
      Bucket: bucket(),
      Key: objectDigest === undefined ? releaseModKey(gameId, presetId, release, location.file, location.store) : objectKey(objectDigest),
      ResponseContentDisposition: attachmentDisposition(location.file),
    }), { expiresIn }),
  };
}

function releaseBucket(): string {
  const bucket = process.env.RELEASE_BUCKET;
  if (!bucket) throw new Error("missing environment variable: RELEASE_BUCKET");
  return bucket;
}

/** The deployed links. The manifest reader is passed in so that a release read stays one shared path. */
export function awsReleaseLinks(readManifest: ManifestReader): ReleaseLinks {
  return s3ReleaseLinks(new S3Client({}), releaseBucket, readManifest);
}
