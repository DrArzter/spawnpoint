// The bot's AWS port: every SDK call lives here, so commands stay glue and the
// local control plane (ADR-0031) can swap endpoints without touching them.

import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ListExecutionsCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

import { buildLifecycleStartInput } from "../../domain/telegram-bot.ts";
import { clientPackKey } from "../../control-plane/release-artifacts.ts";
import { S3ReleaseStateStore } from "../../control-plane/s3-release-state-store.ts";
import { S3WorldRepository } from "../../control-plane/s3-world-repository.ts";

export const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
};

const region = env("AWS_REGION");
const sfn = new SFNClient({ region });
const ec2 = new EC2Client({ region });
const s3 = new S3Client({ region });
const ssm = new SSMClient({ region });

// Secrets and configuration from Parameter Store. The token and webhook secret
// never change and cache for the container's life; the allow-list is edited
// with put-parameter --overwrite, so it re-reads after a short TTL rather than
// holding until a cold start.
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

export async function readPointer(): Promise<Pointer | null> {
  try {
    const bucket = env("RELEASE_BUCKET");
    const world = await new S3WorldRepository(s3, bucket).read(env("WORLD_ID"));
    if (world === null) return null;
    const release = await new S3ReleaseStateStore(s3, bucket).read({
      worldId: world.record.worldId,
      generationId: world.record.currentGeneration.id,
    });
    if (release === null) return null;
    return {
      game: world.record.gameId,
      preset: world.record.preset.id,
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

export async function startIsRunning(): Promise<boolean> {
  const [running, host] = await Promise.all([
    sfn.send(new ListExecutionsCommand({
      stateMachineArn: env("START_STATE_MACHINE_ARN"),
      statusFilter: "RUNNING",
      maxResults: 1,
    })),
    instanceState(),
  ]);
  return (running.executions ?? []).length > 0 || host !== "stopped";
}

// One session = the start machine plus its watchdog, attributed to whoever asked.
export async function startSession(requestedBy: string): Promise<string> {
  const operationId = `bot-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}Z`;
  await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: env("START_STATE_MACHINE_ARN"),
      name: operationId,
      input: JSON.stringify(
        buildLifecycleStartInput({
          serverId: env("SERVER_ID"),
          operationId,
          sessionId: `session-${randomUUID()}`,
          instanceId: env("INSTANCE_ID"),
          // The bot has no world picker yet, so it names the world it is
          // configured for rather than relying on a machine default, which no
          // longer exists.
          worldId: env("WORLD_ID"),
          requestedBy,
        }),
      ),
    }),
  );
  return operationId;
}

export async function packUrl(game: string, preset: string, release: string): Promise<string | null> {
  const key = clientPackKey(game, preset, release);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env("RELEASE_BUCKET"), Key: key }));
  } catch {
    return null;
  }
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env("RELEASE_BUCKET"), Key: key }), {
    expiresIn: 3600,
  });
}
