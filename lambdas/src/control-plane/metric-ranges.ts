import { METRIC_RANGES as RANGES, METRIC_RANGE_NAMES as NAMES } from "../../../contract/metrics.ts";

/**
 * The windows a metrics request may ask for, in hours (contract/metrics.ts).
 * Indexed by any string here, because a request names its range as text.
 */
export const METRIC_RANGES: Readonly<Record<string, number>> = RANGES;

export const METRIC_RANGE_NAMES: readonly string[] = NAMES;
