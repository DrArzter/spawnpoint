/** The idle watchdog's timing, as every session start passes it (ADR-0015). */
export const WATCHDOG_TIMING = {
  checkIntervalSeconds: 900,
  emptyChecksRequired: 3,
  maxTotalChecks: 32,
  maxConsecutiveProbeFailures: 6,
  maxStopRefusals: 3,
  probePollSeconds: 10,
  maxProbePolls: 30,
} as const;

/**
 * How long a player reading stays current: one missed probe, and the longest a
 * probe may wait for its answer. A reading older than this comes from a watchdog
 * that stopped probing, so it no longer says who is online.
 */
export const PLAYER_READING_FRESH_SECONDS =
  2 * WATCHDOG_TIMING.checkIntervalSeconds + WATCHDOG_TIMING.probePollSeconds * WATCHDOG_TIMING.maxProbePolls;
