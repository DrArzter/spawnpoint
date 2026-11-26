import { DescribeExecutionCommand, StartExecutionCommand, type SFNClient } from "@aws-sdk/client-sfn";

import { buildLifecycleStartInput } from "../domain/telegram-bot.ts";
import type { SessionMoves } from "./spot-interruption.ts";

/** The move port over Step Functions: the watchdog's input says what the start was given. */
export function awsSessionMoves(sfn: Pick<SFNClient, "send">, startMachineArn: string, appCommit: string): SessionMoves {
  return {
    async origin(watchdogExecutionId) {
      const execution = await sfn.send(new DescribeExecutionCommand({ executionArn: watchdogExecutionId }));
      try {
        const input = JSON.parse(execution.input ?? "{}") as Record<string, unknown>;
        const gameId = typeof input.gameId === "string" ? input.gameId : null;
        const worldName = typeof input.worldName === "string" ? input.worldName : "";
        return gameId === null ? null : { gameId, worldName };
      } catch {
        return null;
      }
    },
    async start(move) {
      const started = await sfn.send(new StartExecutionCommand({
        stateMachineArn: startMachineArn,
        name: move.operationId,
        input: JSON.stringify(buildLifecycleStartInput({
          serverId: move.serverId, gameId: move.gameId, worldName: move.worldName, operationId: move.operationId,
          sessionId: move.sessionId, instanceId: "", worldId: move.worldId, requestedBy: "spot-interruption",
          placement: "fleet", launch: "enabled", appCommit, policy: "cold", moveVolumeId: move.volumeId,
        })),
      }));
      if (!started.executionArn) throw new Error("move execution did not return an ARN");
      return started.executionArn;
    },
  };
}
