import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { randomUUID } from "node:crypto";

import { buildLifecycleStartInput, buildLifecycleStopInput, buildPromotionInput, buildStopInput } from "../domain/telegram-bot.ts";
import { operationMachines } from "./aws.ts";
import type { OperationObservation } from "./read-model.ts";
import type { PromotionRun, SessionMachines, StartSessionRun, StopSessionRun, WorldLifecycleRun } from "./session-machines.ts";

// The lifecycle machines (ADR-0006, ADR-0062, ADR-0078): each request starts
// one execution, and the execution is the operation record.

type MachineType = OperationObservation["type"];

const sfn = new SFNClient({});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
}

function machineArn(type: MachineType): string {
  const machine = operationMachines().find((candidate) => candidate.type === type);
  if (!machine) throw new Error(`missing ${type} state machine`);
  return machine.arn;
}

// The world id reaches a shell command on the host through the machines'
// States.Format, so its shape is checked here as well as by load_world there.
const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
function requireWorldId(worldId: string): string {
  if (!WORLD_ID.test(worldId)) throw new Error(`invalid world id: ${worldId}`);
  return worldId;
}

function configuredPlacement(): "single" | "shared" | "fleet" {
  const placement = process.env.SPAWNPOINT_PLACEMENT;
  return placement === "shared" || placement === "fleet" ? placement : "single";
}

async function startSessionExecution(args: StartSessionRun): Promise<string> {
  const { operationId, instanceId, requestedBy, serverId, gameId, worldId, worldName, placement, policy, market } = args;
  requireWorldId(worldId);
  const started = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("start"), name: operationId,
    input: JSON.stringify(buildLifecycleStartInput({
      serverId, gameId, worldName, operationId, sessionId: `session-${randomUUID()}`, instanceId, worldId, requestedBy,
      placement: placement ?? configuredPlacement(),
      launch: process.env.SPAWNPOINT_LAUNCH === "enabled" ? "enabled" : "disabled",
      appCommit: process.env.SPAWNPOINT_APP_COMMIT || "main",
      ...(policy === undefined ? {} : { policy }),
      ...(market === undefined ? {} : { market }),
    })),
  }));
  if (!started.executionArn) throw new Error("start execution did not return an ARN");
  return started.executionArn;
}

async function stopSessionExecution(args: StopSessionRun): Promise<string> {
  const { operationId, instanceId, requestedBy, serverId, sessionId, worldId, players = "refuse" } = args;
  requireWorldId(worldId);
  const stopped = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("stop"), name: operationId,
    input: JSON.stringify(buildLifecycleStopInput({ serverId, operationId, sessionId, instanceId, worldId, requestedBy, players })),
  }));
  if (!stopped.executionArn) throw new Error("stop execution did not return an ARN");
  return stopped.executionArn;
}

/** Starts the promote-release machine for a fleet world (ADR-0078); the execution is the operation record. */
async function promotionExecution(args: PromotionRun): Promise<string> {
  requireWorldId(args.worldId);
  const started = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("promote"), name: args.operationId,
    input: JSON.stringify(buildPromotionInput({
      ...args,
      releaseBucket: requiredEnv("RELEASE_BUCKET"),
      launch: process.env.SPAWNPOINT_LAUNCH === "enabled" ? "enabled" : "disabled",
      appCommit: process.env.SPAWNPOINT_APP_COMMIT || "main",
    })),
  }));
  if (!started.executionArn) throw new Error("promotion execution did not return an ARN");
  return started.executionArn;
}

async function worldLifecycleExecution(args: WorldLifecycleRun): Promise<string> {
  const { operationId, instanceId, requestedBy, serverId, sessionId, worldId, action, backupKey, release, stopRequired, targetGenerationId } = args;
  requireWorldId(worldId);
  const stop = buildStopInput({ operationId, instanceId, requestedBy, worldId });
  const started = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("world"), name: operationId,
    input: JSON.stringify({
      serverId, operationId, sessionId, leaseTtlSeconds: 1800, instanceId, requestedBy, worldId, action, stopRequired, targetGenerationId,
      stopTiming: stop.timing,
      requestedAt: new Date().toISOString(),
      generationUuid: randomUUID(),
      backupKey: backupKey ?? "",
      release: release ?? "",
    }),
  }));
  if (!started.executionArn) throw new Error("world lifecycle execution did not return an ARN");
  return started.executionArn;
}

export const awsSessionMachines: SessionMachines = {
  start: startSessionExecution,
  stop: stopSessionExecution,
  promote: promotionExecution,
  worldLifecycle: worldLifecycleExecution,
};
