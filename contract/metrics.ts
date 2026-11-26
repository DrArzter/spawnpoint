// A host's or a world's metrics.

/** The windows a metrics request may ask for, in hours. The API, the MCP tools and the panel offer exactly these. */
export const METRIC_RANGES = { "6h": 6, "24h": 24, "7d": 168 } as const;

export type MetricRange = keyof typeof METRIC_RANGES;

export const METRIC_RANGE_NAMES: readonly MetricRange[] = Object.keys(METRIC_RANGES) as MetricRange[];

/** Every unit a series' value or capacity is sent in. */
export const METRIC_UNITS = ["percent", "bytesPerSecond", "cores", "bytes"] as const;

export type MetricUnit = (typeof METRIC_UNITS)[number];

/**
 * `interpolated`: a reading drawn between two real ones, memory only; it is a line, never a stat.
 * `capacity`: the whole of the host that gave this reading, in the series' `capacityUnit`, so a
 * percentage reads as an absolute (`value / 100 * capacity`). Absent when that host's shape is unknown.
 */
export type HostMetricPoint = Readonly<{ at: string; value: number | null; interpolated?: true; capacity?: number }>;

export type HostMetricSeries = Readonly<{
  id: string;
  label: string;
  /** A `MetricUnit`. */
  unit: string;
  /** The unit of the points' `capacity`; absent on a series that has none. */
  capacityUnit?: MetricUnit;
  points: readonly HostMetricPoint[];
  /**
   * While the world's session runs: the first slot that cannot hold a reading
   * yet, because the newest readings arrive late. An empty slot from here on is
   * "not reported yet", not "no host". Absent when nothing is pending.
   */
  pendingFrom?: string;
}>;

/** What GET .../metrics sends for a host or a world. */
export type HostMetrics = Readonly<{
  range: MetricRange;
  startedAt: string;
  endedAt: string;
  periodSeconds: number;
  series: readonly HostMetricSeries[];
  /** The host series' `pendingFrom`, for the strip. */
  pendingFrom?: string;
}>;
