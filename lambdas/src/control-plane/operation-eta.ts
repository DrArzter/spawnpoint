// What an operation usually takes, from the runs of the same type for the same world.

/** Runs that count, newest first. */
export const ETA_RUNS = 10;
/** Fewer runs than this say too little to promise a time. */
export const ETA_MIN_RUNS = 3;

export type OperationExpectation = Readonly<{ expectedSeconds: number; expectedSamples: number }>;

export type FinishedRun = Readonly<{ executionArn: string; worldId: string | null; startDate: Date; stopDate: Date }>;

/** The average of the newest runs of one world; null when there are too few. */
export function expectationFromRuns(runsNewestFirst: readonly FinishedRun[], worldId: string): OperationExpectation | null {
  const seconds = runsNewestFirst
    .filter((run) => run.worldId === worldId)
    .slice(0, ETA_RUNS)
    .map((run) => (run.stopDate.getTime() - run.startDate.getTime()) / 1000)
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (seconds.length < ETA_MIN_RUNS) return null;
  const mean = seconds.reduce((sum, value) => sum + value, 0) / seconds.length;
  return { expectedSeconds: Math.round(mean), expectedSamples: seconds.length };
}
