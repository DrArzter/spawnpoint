import { t } from "../i18n";
/** A duration as m:ss; minutes carry on past 59. */
export function clock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Seconds since `since`, or null when it is not a time. */
export function elapsedSeconds(since: string | undefined, now: number): number | null {
  const start = since ? Date.parse(since) : Number.NaN;
  return Number.isNaN(start) ? null : Math.max(0, Math.floor((now - start) / 1000));
}

/** What the backend learned of an operation's usual duration. */
export type Expectation = Readonly<{ expectedSeconds?: number; expectedSamples?: number }>;

export type Eta = Readonly<{
  /** `left` counts down to the usual end; `over` is past it. */
  kind: "left" | "over";
  text: string;
  /** The usual duration, for the tooltip. */
  tip: string;
}>;

/** The ETA beside a running time; null when the backend has no history to offer. */
export function eta(since: string | undefined, expectation: Expectation, now: number): Eta | null {
  const expected = expectation.expectedSeconds;
  const elapsed = elapsedSeconds(since, now);
  if (expected === undefined || elapsed === null) return null;
  const samples = expectation.expectedSamples;
  const from = samples ? t("operation.fromLastSamplesRuns", { samples }) : "";
  const tip = t("operation.usuallyClockFrom", { clock: clock(expected), from });
  return elapsed < expected
    ? { kind: "left", text: t("operation.eTAClock", { clock: clock(expected - elapsed) }), tip }
    : { kind: "over", text: t("operation.takingLonger"), tip };
}
