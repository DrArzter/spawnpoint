import { CopyObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";

import type { ObjectPort } from "./object-writer.ts";

type Client = Pick<S3Client, "send">;

export type PortOptions = Readonly<{ attempts?: number; sleep?: (milliseconds: number) => Promise<void> }>;

const TRANSIENT_NAMES = new Set(["RequestTimeout", "RequestTimeoutException", "ThrottlingException", "SlowDown", "InternalError", "ServiceUnavailable", "TimeoutError", "NetworkingError", "ConditionalRequestConflict"]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "EAI_AGAIN"]);

function status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

function transient(error: unknown): boolean {
  const { name, code } = error as { name?: string; code?: string };
  const http = status(error);
  return (name !== undefined && TRANSIENT_NAMES.has(name)) || (code !== undefined && TRANSIENT_CODES.has(code)) || (http !== undefined && http >= 500);
}

/** S3 answers a missing key with 404, or 403 for a role that cannot list the bucket. */
function absent(error: unknown): boolean {
  const http = status(error);
  return http === 404 || http === 403 || (error as { name?: string }).name === "NotFound";
}

/**
 * The SDK port. The client must not retry a body by itself (a consumed stream
 * cannot be sent again), so each attempt here opens a fresh read stream.
 */
export function s3ObjectPort(client: Client, bucket: string, options: PortOptions = {}): ObjectPort {
  const attempts = options.attempts ?? 4;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); }));

  const retrying = async <T>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        if (attempt >= attempts || !transient(error)) throw error;
        await sleep(250 * 2 ** (attempt - 1));
      }
    }
  };

  const head = (key: string) => retrying(async () => {
    try {
      const found = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }));
      return { bytes: Number(found.ContentLength ?? -1), checksumSha256: found.ChecksumSHA256 };
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
  });

  return {
    head,
    put: (key, source, checksumSha256) => retrying(async () => {
      try {
        // No file name and no metadata: the same bytes have other names in other releases.
        const response = await client.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: createReadStream(source.path), ContentLength: source.bytes,
          ContentType: "application/octet-stream", ServerSideEncryption: "AES256",
          ChecksumAlgorithm: "SHA256", ChecksumSHA256: checksumSha256, IfNoneMatch: "*",
        }));
        return { status: "created" as const, checksumSha256: response.ChecksumSHA256 };
      } catch (error) {
        if (status(error) === 412) return { status: "exists" as const, checksumSha256: undefined };
        throw error;
      }
    }),
    copy: (sourceKey, key) => retrying(async () => {
      try {
        await client.send(new CopyObjectCommand({
          Bucket: bucket, Key: key, CopySource: `${bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
          ServerSideEncryption: "AES256", ContentType: "application/octet-stream", MetadataDirective: "REPLACE",
          ChecksumAlgorithm: "SHA256", IfNoneMatch: "*",
        }));
        return "created" as const;
      } catch (error) {
        if (status(error) === 412) return "exists" as const;
        throw error;
      }
    }),
  };
}
