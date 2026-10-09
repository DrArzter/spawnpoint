// Which execution events become chat messages, and their wording. Step
// Functions emits every execution's status changes to EventBridge, so the
// machines need no announce states: the execution lifecycle IS the event.
// The judgement here is mostly about silence — child executions (the
// watchdog's stops, promotion's stops and starts) would double-announce what
// their parents already say.

export type ExecutionEvent = Readonly<{
  machine: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED";
  name: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  cause: string | null;
}>;

export type NotificationSubscriptionKey = `${string}.started` | `${string}.stopped` | "invitation.broadcast" | "invitation.direct";

// Lifecycle V2 composes the V1 machines and is what EventBridge routes here
// since the cutover; its start, stop and watchdog say the same things to
// players, so they are announced under their V1 names. The V1 machines now
// run only as V2's children, and the rule does not route them.
const ANNOUNCED_AS: Readonly<Record<string, string>> = {
  "spawnpoint-start-server-v2": "spawnpoint-start-server",
  "spawnpoint-stop-server-v2": "spawnpoint-stop-server",
  "spawnpoint-idle-watchdog-v2": "spawnpoint-idle-watchdog",
};

export function parseExecutionEvent(detail: unknown): ExecutionEvent | null {
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as Record<string, unknown>;
  if (typeof d.stateMachineArn !== "string" || typeof d.status !== "string" || typeof d.name !== "string") {
    return null;
  }
  const arnName = d.stateMachineArn.split(":").pop() ?? "";
  const machine = ANNOUNCED_AS[arnName] ?? arnName;
  const parse = (raw: unknown): Record<string, unknown> | null => {
    if (typeof raw !== "string") return null;
    try {
      const value = JSON.parse(raw);
      return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  return {
    machine,
    status: d.status as ExecutionEvent["status"],
    name: d.name,
    input: parse(d.input),
    output: parse(d.output),
    error: typeof d.error === "string" ? d.error : null,
    cause: typeof d.cause === "string" ? d.cause : null,
  };
}

const str = (record: Record<string, unknown> | null, key: string): string | null => {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
};

// A watchdog child stop is named <op>-idle-N / <op>-cap-N; promotion's
// children end in -stop / -restop / -rollback / -rollback-stop / -start.
const CHILD_NAME = /-(idle|cap)-[0-9]+$|-(re)?stop$|-rollback(-stop)?$|-start$/;

const GAME_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

// A V2 input names its game as the lifecycle's server id; a V1 input, the
// legacy shape, named the world, and only Factorio's world was its game.
function eventGame(event: ExecutionEvent): string {
  const named = str(event.input, "gameId") ?? str(event.input, "serverId");
  if (named !== null && GAME_ID.test(named)) return named;
  const worldId = str(event.input, "worldId") ?? str(event.input, "world");
  return worldId === "factorio" ? "factorio" : "minecraft";
}

export function notificationSubscriptionKey(event: ExecutionEvent): NotificationSubscriptionKey | null {
  if (CHILD_NAME.test(event.name)) return null;
  const game = eventGame(event);
  if (event.machine === "spawnpoint-start-server" && (event.status === "RUNNING" || event.status === "SUCCEEDED")) {
    return `${game}.started`;
  }
  if (event.machine === "spawnpoint-idle-watchdog" && event.status === "SUCCEEDED") {
    const status = str(event.output, "status");
    if (status === "stopped_idle" || status === "stopped_session_cap") return `${game}.stopped`;
  }
  return null;
}

export function renderNotification(event: ExecutionEvent): string | null {
  const requester = str(event.input, "requestedBy");
  // Two worlds of one game can run at once (ADR-0062), so a message names its
  // world when the workflow was given the name; older inputs carry none.
  const world = str(event.input, "worldName") || null;
  const failed = event.status === "FAILED" || event.status === "TIMED_OUT" || event.status === "ABORTED";

  switch (event.machine) {
    case "spawnpoint-start-server": {
      if (CHILD_NAME.test(event.name)) return null;
      if (event.status === "RUNNING") {
        return `[STARTING] ${requester ?? "the owner"} requested ${world ?? "the server"}. Mods take a few minutes.`;
      }
      if (event.status === "SUCCEEDED") {
        const address = str(event.output, "connectionAddress") ?? str(event.output, "address");
        const up = world === null ? "Server is up" : `${world} is up`;
        return address === null ? `[READY] ${up}.` : `[READY] ${up}: ${address}`;
      }
      const start = world === null ? "Start" : `Start of ${world}`;
      return `[FAILED] ${start} failed (${event.name}). The owner can read the execution history.`;
    }

    case "spawnpoint-idle-watchdog": {
      if (event.status === "RUNNING") return null;
      if (event.status === "SUCCEEDED") {
        switch (str(event.output, "status")) {
          case "stopped_idle":
            return world === null
              ? "[STOPPED] Nobody online — server saved, backed up and stopped."
              : `[STOPPED] ${world}: nobody online — saved, backed up and stopped.`;
          case "stopped_session_cap":
            return world === null
              ? "[STOPPED] Session cap reached — server saved, backed up and stopped."
              : `[STOPPED] ${world}: session cap reached — saved, backed up and stopped.`;
          default:
            return null;
        }
      }
      return `[ALARM] The idle watchdog died (${event.name}). If the server is up, it will not stop itself — the running-hours alarm is the backstop.`;
    }

    case "spawnpoint-stop-server": {
      // Successes are announced by whoever ordered the stop; the owner CLI
      // prints its own result. A FAILED stop is a failed backup contract and
      // is always worth a message, child or not.
      if (!failed) return null;
      // Not failures of the backup contract: a player came back during the
      // final recheck, or the session had already ended. The world is safe.
      if (event.error === "Spawnpoint.V2StaleSession") return null;
      if (event.error === "Spawnpoint.V2StopRefusedPlayersOnline") {
        return CHILD_NAME.test(event.name) ? null : "[STOP CANCELLED] Players are online, so the server keeps running. Nothing was lost.";
      }
      if (event.error === "Spawnpoint.HostActivityUnknown") {
        return `[ALARM] The world was saved and its backup verified (${event.name}), but host activity could not be checked. EC2 may still be running.`;
      }
      return `[ALARM] A stop failed (${event.name}) — the world may be unsaved or the backup unverified, and EC2 may still be running.`;
    }

    case "spawnpoint-drain-host-v2": {
      if (!failed) return null;
      const hostId = str(event.input, "hostId") ?? "unknown host";
      return `[ALARM] Fleet drain failed for ${hostId} (${event.name}). EC2 may still be billed; the scheduled Fleet sweep will retry or flag it for review.`;
    }

    case "spawnpoint-promote-release": {
      if (CHILD_NAME.test(event.name)) return null;
      const release = str(event.input, "release");
      if (event.status === "RUNNING") {
        return `[DEPLOYING] Release ${release ?? "?"} is being promoted.`;
      }
      if (event.status === "SUCCEEDED") {
        switch (str(event.output, "status")) {
          case "promoted":
            return `[DEPLOYED] Release ${release ?? "?"} is live${str(event.output, "server") === "running" ? " and the server is up" : ""}. /pack for the new archive.`;
          case "rolled_back":
            return `[ROLLED BACK] Release ${release ?? "?"} failed its health check and was rolled back to ${str(event.output, "active_release") ?? "the previous release"}. Nothing to update.`;
          case "already_active":
            return null;
          default:
            return null;
        }
      }
      return `[FAILED] Promotion of ${release ?? "?"} failed (${event.name}). The pointer tells the truth; see the runbook.`;
    }

    default:
      return null;
  }
}
