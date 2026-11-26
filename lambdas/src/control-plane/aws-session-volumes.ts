import { DeleteVolumeCommand, DescribeVolumesCommand, type EC2Client } from "@aws-sdk/client-ec2";

import {
  SESSION_VOLUME_MANAGED_BY,
  SESSION_VOLUME_SESSION_TAG,
  SESSION_VOLUME_WORLD_TAG,
  type SessionVolume,
} from "../domain/session-volume.ts";
import type { SessionVolumes } from "./session-volume-sweep.ts";

/** The session volume port over EC2: only volumes tagged as Spawnpoint's session volumes. */
export function awsSessionVolumes(ec2: Pick<EC2Client, "send">): SessionVolumes {
  return {
    async list() {
      const volumes: SessionVolume[] = [];
      let NextToken: string | undefined;
      do {
        const page = await ec2.send(new DescribeVolumesCommand({
          Filters: [{ Name: "tag:ManagedBy", Values: [SESSION_VOLUME_MANAGED_BY] }],
          NextToken,
        }));
        for (const volume of page.Volumes ?? []) {
          if (!volume.VolumeId) continue;
          const tag = (key: string) => volume.Tags?.find((candidate) => candidate.Key === key)?.Value ?? null;
          volumes.push({
            volumeId: volume.VolumeId,
            state: volume.State ?? "unknown",
            createdAtEpochSeconds: Math.floor((volume.CreateTime?.getTime() ?? 0) / 1000),
            sessionId: tag(SESSION_VOLUME_SESSION_TAG),
            worldId: tag(SESSION_VOLUME_WORLD_TAG),
          });
        }
        NextToken = page.NextToken;
      } while (NextToken);
      return volumes;
    },
    async delete(volumeId) {
      await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
    },
  };
}
