import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Identity avatars in their bucket (ADR-0084).

const s3 = new S3Client({});

// Read when used, so modules that only import this one start without it.
function avatarBucketName(): string {
  const bucket = process.env.AVATAR_BUCKET;
  if (!bucket) throw new Error("missing environment variable: AVATAR_BUCKET");
  return bucket;
}

export const avatarObjects = {
  /** A link to one picture, signed as of `signingDate`. */
  link: (key: string, expiresIn: number, signingDate: Date): Promise<string> =>
    getSignedUrl(s3, new GetObjectCommand({ Bucket: avatarBucketName(), Key: key }), { expiresIn, signingDate }),
  put: async (key: string, bytes: Uint8Array, contentType: string): Promise<void> => {
    await s3.send(new PutObjectCommand({ Bucket: avatarBucketName(), Key: key, Body: bytes, ContentType: contentType, CacheControl: "private, max-age=3600" }));
  },
  keys: async (prefix: string): Promise<readonly string[]> => {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: avatarBucketName(), Prefix: prefix }));
    return (listed.Contents ?? []).flatMap((object) => object.Key === undefined ? [] : [object.Key]);
  },
  remove: async (keys: readonly string[]): Promise<void> => {
    if (keys.length > 0) await s3.send(new DeleteObjectsCommand({ Bucket: avatarBucketName(), Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
  },
};
