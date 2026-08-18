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
}>;

export function parseExecutionEvent(detail: unknown): ExecutionEvent | null {
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as Record<string, unknown>;
  if (typeof d.stateMachineArn !== "string" || typeof d.status !== "string" || typeof d.name !== "string") {
    return null;
  }
  const machine = d.stateMachineArn.split(":").pop() ?? "";
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
  };
}

const str = (record: Record<string, unknown> | null, key: string): string | null => {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
};

// A watchdog child stop is named <op>-idle-N / <op>-cap-N; promotion's
// children end in -stop / -restop / -rollback / -rollback-stop / -start.
const CHILD_NAME = /-(idle|cap)-[0-9]+$|-(re)?stop$|-rollback(-stop)?$|-start$/;

export function renderNotification(event: ExecutionEvent): string | null {
  const requester = str(event.input, "requestedBy");
  const failed = event.status === "FAILED" || event.status === "TIMED_OUT" || event.status === "ABORTED";

  switch (event.machine) {
    case "spawnpoint-start-server": {
      if (CHILD_NAME.test(event.name)) return null;
      if (event.status === "RUNNING") {
        return `⏳ ${requester ?? "the owner"} requested the server. Mods take a few minutes.`;
      }
      if (event.status === "SUCCEEDED") {
        const address = str(event.output, "connectionAddress") ?? str(event.output, "address");
        return address === null ? "✅ Server is up." : `✅ Server is up: ${address}`;
      }
      return `❌ Start failed (${event.name}). The owner can read the execution history.`;
    }

    case "spawnpoint-idle-watchdog": {
      if (event.status === "RUNNING") return null;
      if (event.status === "SUCCEEDED") {
        switch (str(event.output, "status")) {
          case "stopped_idle":
            return "🌙 Nobody online — server saved, backed up and stopped.";
          case "stopped_session_cap":
            return "⏱ Session cap reached — server saved, backed up and stopped.";
          default:
            return null;
        }
      }
      return `🚨 The idle watchdog died (${event.name}). If the server is up, it will not stop itself — the running-hours alarm is the backstop.`;
    }

    case "spawnpoint-stop-server": {
      // Successes are announced by whoever ordered the stop; the owner CLI
      // prints its own result. A FAILED stop is a failed backup contract and
      // is always worth a message, child or not.
      if (!failed) return null;
      return `🚨 A stop failed (${event.name}) — the world may be unsaved or the backup unverified, and EC2 may still be running.`;
    }

    case "spawnpoint-promote-release": {
      if (CHILD_NAME.test(event.name)) return null;
      const release = str(event.input, "release");
      if (event.status === "RUNNING") {
        return `🚀 Release ${release ?? "?"} is being promoted.`;
      }
      if (event.status === "SUCCEEDED") {
        switch (str(event.output, "status")) {
          case "promoted":
            return `📦 Release ${release ?? "?"} is live${str(event.output, "server") === "running" ? " and the server is up" : ""}. /pack for the new archive.`;
          case "rolled_back":
            return `↩️ Release ${release ?? "?"} failed its health check and was rolled back to ${str(event.output, "active_release") ?? "the previous release"}. Nothing to update.`;
          case "already_active":
            return null;
          default:
            return null;
        }
      }
      return `❌ Promotion of ${release ?? "?"} failed (${event.name}). The pointer tells the truth; see the runbook.`;
    }

    default:
      return null;
  }
}
