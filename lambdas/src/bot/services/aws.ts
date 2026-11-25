// The bot's AWS port: every SDK call lives here, so commands stay glue and the
// local control plane (ADR-0031) can swap endpoints without touching them.

import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { attachmentDisposition, packAttachmentName, releaseManifestKey } from "../../control-plane/release-artifacts.ts";
import { releasePackStorageKey } from "../../control-plane/release-objects.ts";
import { S3ReleaseStateReader } from "../../control-plane/s3-release-state-store.ts";
import { S3WorldReader } from "../../control-plane/s3-world-repository.ts";
import type { WorldRecord } from "../../control-plane/world-registry.ts";

export const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
};

const region = env("AWS_REGION");
const ec2 = new EC2Client({ region });
const s3 = new S3Client({ region });
const ssm = new SSMClient({ region });

// Secrets and configuration from Parameter Store. A value read with no TTL
// caches for the container's life; a caller that expects a value to change
// with put-parameter --overwrite passes a short TTL.
const cache = new Map<string, { value: string; expiresAt: number }>();
export async function parameter(name: string, ttlSeconds = Infinity): Promise<string> {
  const cached = cache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = response.Parameter?.Value;
  if (!value) throw new Error(`parameter is empty: ${name}`);
  cache.set(name, { value, expiresAt: ttlSeconds === Infinity ? Infinity : Date.now() + ttlSeconds * 1_000 });
  return value;
}

export type Pointer = Readonly<{ game: string; preset: string; desired_release: string | null; active_release: string | null }>;

/** The bot's world as the registry keeps it (ADR-0097); null when it has no record or S3 does not answer. */
export async function readWorldRecord(): Promise<WorldRecord | null> {
  try {
    return (await new S3WorldReader(s3, env("RELEASE_BUCKET")).read(env("WORLD_ID")))?.record ?? null;
  } catch {
    return null;
  }
}

export async function readPointer(): Promise<Pointer | null> {
  try {
    const world = await readWorldRecord();
    if (world === null) return null;
    const release = await new S3ReleaseStateReader(s3, env("RELEASE_BUCKET")).read({
      worldId: world.worldId,
      generationId: world.currentGeneration.id,
    });
    if (release === null) return null;
    return {
      game: world.gameId,
      preset: world.preset.id,
      desired_release: release.state.desiredRelease,
      active_release: release.state.activeRelease,
    };
  } catch {
    return null;
  }
}

// State and the public address come from the same observation: a public
// world's address is whatever the running instance holds, and nothing stores it.
export async function describeHost(): Promise<Readonly<{ state: string; publicIp: string | null }>> {
  const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [env("INSTANCE_ID")] }));
  const instance = described.Reservations?.[0]?.Instances?.[0];
  return { state: instance?.State?.Name ?? "unknown", publicIp: instance?.PublicIpAddress ?? null };
}

export async function instanceState(): Promise<string> {
  return (await describeHost()).state;
}

// An objects-v1 release keeps its pack as an object named by digest, so the
// manifest decides the key and the attachment name tells the player what it is.
export async function packUrl(game: string, preset: string, release: string): Promise<string | null> {
  const bucket = env("RELEASE_BUCKET");
  const key = releasePackStorageKey(await readManifest(bucket, game, preset, release), game, preset, release, "client");
  if (key === null) return null;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    return null;
  }
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: attachmentDisposition(packAttachmentName(preset, release, "client")),
  }), { expiresIn: 3600 });
}

async function readManifest(bucket: string, game: string, preset: string, release: string): Promise<unknown> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: releaseManifestKey(game, preset, release) }));
    const body = await response.Body?.transformToString();
    return body ? JSON.parse(body) as unknown : null;
  } catch (error) {
    if (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound")) return null;
    throw error;
  }
}
