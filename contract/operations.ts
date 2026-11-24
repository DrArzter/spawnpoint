// How far one world operation has come (`GET .../operations/{id}`).

/** One step of a running workflow: the key is stable, the label is the server's plain words. */
export type OperationStep = Readonly<{ key: string; label: string }>;

export type HostLogKind = "step" | "result" | "container" | "error" | "warning" | "game";

/** One line of the host's own output while a start ran, already filtered and redacted by the API. */
export type HostLogLine = Readonly<{ at: string; kind: HostLogKind; text: string }>;

/** The nested start or stop workflow's step, only while it runs. */
export type ChildProgress = Readonly<{ type: "start" | "stop"; step: OperationStep }>;

/** A task error the workflow caught, such as before a rollback. */
export type CaughtError = Readonly<{ error: string; cause: string; step: OperationStep | null }>;

export type OperationProgress = Readonly<{
  id: string;
  type: "start" | "stop" | "promote" | "world";
  status: "running" | "succeeded" | "failed" | "timed_out" | "aborted";
  startedAt: string;
  stoppedAt: string | null;
  elapsedSeconds: number;
  /** The usual duration, from earlier runs of the same operation. */
  expectedSeconds?: number;
  expectedSamples?: number;
  /** Only while running. */
  step: OperationStep | null;
  child: ChildProgress | null;
  /** The workflow's status on success: "promoted", "rolled_back", "already_active". */
  result: string | null;
  /** The workflow's own error name and cause, once it failed, timed out or was aborted. */
  failure: Readonly<{ error: string; cause: string }> | null;
  caught: CaughtError | null;
  /** The host's lines of a start or promotion, oldest first; absent when the API could not read them. */
  hostLog?: readonly HostLogLine[];
}>;
