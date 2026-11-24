import { useEffect, useRef, useState } from "react";

import type { HostLogLine, OperationProgress } from "../api/contract";
import { useApi } from "../api/context";
import { clock, elapsedSeconds, eta } from "../lib/operation-time";
import type { Operation } from "../model";
import type { Detail, DetailValue, HostLogRow, OperationProgressModel } from "./models";
import type { StatusDescriptor } from "./status";
import { operationLabel } from "./worlds";

/*
 * How far a running world operation has come. The page lists running
 * operations from its snapshot; this reads one of them in more detail while
 * it runs, and once more when it ends, so a failure keeps its real cause.
 */

export const POLL_MS = 4000;
/** About half an hour of polling at the cadence above. */
export const MAX_POLLS = 450;
export const MAX_FAILURES = 3;

/** The words of the rows, in one place. */
export const PROGRESS_LABELS = {
  step: "Step",
  child: "Sub-step",
  elapsed: "Elapsed",
  expected: "Expected",
  error: "Error",
  cause: "Cause",
  caught: "Caught",
  caughtCause: "Caught cause",
  caughtAt: "Caught at",
} as const;

const failureStatus: Readonly<Record<string, StatusDescriptor>> = {
  failed: { kind: "error", label: "Failed" },
  timed_out: { kind: "error", label: "Timed out" },
  aborted: { kind: "error", label: "Aborted" },
};

/** The newest running operation that names this world. */
export function newestRunning(operations: readonly Operation[], worldId: string): Operation | null {
  let newest: Operation | null = null;
  for (const operation of operations) {
    if (operation.worldId !== worldId) continue;
    if (newest === null || Date.parse(operation.startedAt) >= Date.parse(newest.startedAt)) newest = operation;
  }
  return newest;
}

/** Whether an ended operation is worth keeping on the page. */
export function endedBadly(progress: OperationProgress): boolean {
  return progress.status in failureStatus || (progress.status === "succeeded" && progress.caught !== null && progress.result === "rolled_back");
}

function statusOf(progress: OperationProgress): StatusDescriptor {
  if (progress.status === "running") return { kind: "progress", label: "Running" };
  if (progress.status === "succeeded") return endedBadly(progress) ? { kind: "warning", label: "Rolled back" } : { kind: "ok", label: "Done" };
  return failureStatus[progress.status] ?? { kind: "error", label: "Failed" };
}

/** What the page tells: the running operation with what the API knows of it, else one kept after it ended badly. */
export function progressModel(running: Operation | null, progress: OperationProgress | null): OperationProgressModel | null {
  if (running !== null) {
    const known = progress?.id === running.id ? progress : null;
    if (known === null || known.status === "running") return build(running.id, running.type, running.startedAt, running, known);
    return build(known.id, known.type, known.startedAt, known, known);
  }
  return progress !== null && endedBadly(progress) ? build(progress.id, progress.type, progress.startedAt, progress, progress) : null;
}

function build(id: string, type: Operation["type"], startedAt: string, expected: Readonly<{ expectedSeconds?: number; expectedSamples?: number }>, progress: OperationProgress | null): OperationProgressModel {
  const running = progress === null || progress.status === "running";
  return {
    id,
    title: operationLabel(type),
    status: progress === null ? { kind: "progress", label: "Running" } : statusOf(progress),
    running,
    known: progress !== null,
    nests: type !== "world",
    logged: type === "start" || type === "promote",
    startedAt,
    ranSeconds: running ? null : progress.elapsedSeconds,
    expectation: { ...(expected.expectedSeconds === undefined ? {} : { expectedSeconds: expected.expectedSeconds }), ...(expected.expectedSamples === undefined ? {} : { expectedSamples: expected.expectedSamples }) },
    step: progress?.step?.label ?? null,
    child: progress?.child?.step.label ?? null,
    failure: progress?.failure ?? null,
    caught: progress?.caught ? { error: progress.caught.error, cause: progress.caught.cause, step: progress.caught.step?.label ?? null } : null,
    log: hostLogRows(progress?.hostLog ?? []),
  };
}

function toneOf(line: HostLogLine): HostLogRow["tone"] {
  if (line.kind === "error") return "error";
  if (line.kind === "warning") return "warning";
  if (line.kind !== "game") return "plain";
  return /\b(?:ERROR|FATAL)\b|Exception|Error\b/.test(line.text) ? "error" : "warning";
}

/** The host's lines as rows; a line that repeats keeps a distinct id. */
export function hostLogRows(lines: readonly HostLogLine[]): HostLogRow[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const base = `${line.at}|${line.text}`;
    const nth = seen.get(base) ?? 0;
    seen.set(base, nth + 1);
    return { id: `${base}|${nth}`, at: line.at, text: line.text, tone: toneOf(line) };
  });
}

/** The time a log line is printed at: the clock of the person reading it. */
export function logTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("en-GB", { hour12: false });
}

// While it runs, the step rows keep their place: a placeholder until the API answers, then "—" when there is none.
function stepRows(model: OperationProgressModel): Detail[] {
  const text = (value: string): DetailValue => ({ type: "text", text: value });
  if (!model.running) {
    const known: Detail[] = [];
    if (model.step !== null) known.push({ label: PROGRESS_LABELS.step, value: text(model.step) });
    if (model.child !== null) known.push({ label: PROGRESS_LABELS.child, value: text(model.child) });
    return known;
  }
  const reserved = (value: string | null): DetailValue => {
    if (!model.known) return { type: "loading" };
    return value === null ? { type: "absent", text: "—" } : text(value);
  };
  const rows: Detail[] = [{ label: PROGRESS_LABELS.step, value: reserved(model.step) }];
  if (model.nests) rows.push({ label: PROGRESS_LABELS.child, value: reserved(model.child) });
  return rows;
}

/** The rows of the progress element at `now`, the same words in every skin. */
export function progressDetails(model: OperationProgressModel, now: number): Detail[] {
  const rows: Detail[] = [];
  const text = (value: string, extra: { mono?: boolean; wrap?: boolean } = {}) => ({ type: "text" as const, text: value, ...extra });
  rows.push(...stepRows(model));
  const seconds = model.running ? elapsedSeconds(model.startedAt, now) : model.ranSeconds;
  rows.push({ label: PROGRESS_LABELS.elapsed, value: seconds === null ? { type: "absent", text: "—" } : text(clock(seconds), { mono: true }) });
  const reading = model.running ? eta(model.startedAt, model.expectation, now) : null;
  if (reading !== null) rows.push({ label: PROGRESS_LABELS.expected, value: text(reading.text, { mono: true }), explain: reading.tip });
  if (model.failure !== null) {
    rows.push(
      { label: PROGRESS_LABELS.error, value: text(model.failure.error, { mono: true, wrap: true }) },
      { label: PROGRESS_LABELS.cause, value: text(model.failure.cause, { wrap: true }) },
    );
  }
  if (model.caught !== null) {
    rows.push(
      { label: PROGRESS_LABELS.caught, value: text(model.caught.error, { mono: true, wrap: true }) },
      { label: PROGRESS_LABELS.caughtCause, value: text(model.caught.cause, { wrap: true }) },
    );
    if (model.caught.step !== null) rows.push({ label: PROGRESS_LABELS.caughtAt, value: text(model.caught.step) });
  }
  return rows;
}

/** The time now, read again every second while `live`. */
export function useSecondClock(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

export type ProgressLoader = (gameId: string, worldId: string, operationId: string) => Promise<OperationProgress | null>;

export type Poller = Readonly<{
  /** The page was shown again: read at once. */
  show: () => void;
  /** The page was hidden: no read until it shows. */
  hide: () => void;
  stop: () => void;
}>;

/**
 * Reads one operation now and every few seconds. It ends when the operation is
 * no longer running, after too many reads or failed reads in a row, or on
 * `stop`. A failed read keeps the last good value; a read that finds nothing
 * counts as a failure. No timer runs while hidden.
 */
export function startPolling(options: Readonly<{ read: () => Promise<OperationProgress | null>; onProgress: (progress: OperationProgress) => void; visible: () => boolean }>): Poller {
  let stopped = false;
  let inflight = false;
  let reads = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = () => { timer = setTimeout(() => { void tick(); }, POLL_MS); };
  async function tick(): Promise<void> {
    clearTimeout(timer);
    if (stopped || inflight || !options.visible()) return;
    inflight = true;
    reads += 1;
    try {
      const progress = await options.read();
      if (stopped) return;
      if (progress === null) failures += 1;
      else {
        failures = 0;
        options.onProgress(progress);
        if (progress.status !== "running") { stopped = true; return; }
      }
    } catch {
      if (stopped) return;
      failures += 1;
    } finally {
      inflight = false;
    }
    if (failures >= MAX_FAILURES || reads >= MAX_POLLS) { stopped = true; return; }
    later();
  }
  void tick();
  return {
    show: () => { void tick(); },
    hide: () => { clearTimeout(timer); },
    stop: () => { stopped = true; clearTimeout(timer); },
  };
}

/** Whether a read is owed when the running operation left the snapshot: not when a poll already saw it end. */
export function owesFinalRead(before: string | null, held: OperationProgress | null): boolean {
  return before !== null && !(held?.id === before && held.status !== "running");
}

type Held = Readonly<{ world: string; progress: OperationProgress }>;

/**
 * The running operation read in detail (see `startPolling`), and once more
 * when it leaves the snapshot, so a failure keeps its cause. Another world
 * starts with nothing.
 */
export function useOperationProgress(
  scope: Readonly<{ gameId: string; worldId: string }> | null,
  running: Operation | null,
  load?: ProgressLoader,
): OperationProgress | null {
  const api = useApi();
  const [held, setHeld] = useState<Held | null>(null);
  const world = scope === null ? null : `${scope.gameId}/${scope.worldId}`;
  const runningId = scope === null ? null : running?.id ?? null;
  const read: ProgressLoader = load ?? ((gameId, worldId, operationId) => api.loadOperationProgress(gameId, worldId, operationId));
  const loader = useRef(read);
  loader.current = read;
  const heldRef = useRef(held);
  heldRef.current = held;
  const before = useRef<Readonly<{ world: string; id: string }> | null>(null);

  useEffect(() => { setHeld((current) => (current !== null && current.world !== world ? null : current)); }, [world]);

  useEffect(() => {
    if (scope === null || world === null || runningId === null) return;
    const poller = startPolling({
      read: () => loader.current(scope.gameId, scope.worldId, runningId),
      onProgress: (progress) => setHeld({ world, progress }),
      visible: () => document.visibilityState !== "hidden",
    });
    const onVisibility = () => (document.visibilityState === "hidden" ? poller.hide() : poller.show());
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.stop();
    };
  }, [world, runningId]);

  useEffect(() => {
    const last = before.current;
    before.current = world !== null && runningId !== null ? { world, id: runningId } : null;
    if (scope === null || last === null || last.world !== world || runningId !== null || !owesFinalRead(last.id, heldRef.current?.progress ?? null)) return;
    let current = true;
    loader.current(scope.gameId, scope.worldId, last.id)
      .then((progress) => { if (current && progress !== null) setHeld({ world: last.world, progress }); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [world, runningId]);

  return held !== null && held.world === world ? held.progress : null;
}
