import type { HostMetricSeries } from "../api/contract";
import { intlLocale, t } from "../i18n";
import { BYTE_DECIMALS, bytePower, byteUnit } from "./format";

// How both skins read a metric series: its name in the catalogue, the unit it
// is drawn in, and its numbers as words. A percentage of a host whose every
// reading says how big that host was reads as an absolute (cores, GiB); one
// reading without it keeps the whole series in percent, so a chart never mixes
// units.

/** A reading in its series' unit, without the time. `interpolated` is a reading the server joined. */
export type MetricPoint = Readonly<{ at: string; value: number | null; interpolated?: boolean }>;

/** A value and its unit, kept apart so the stat draws the unit smaller. */
export type MetricReading = Readonly<{ value: string; unit: string }>;

/** How a chart's ceiling is found when the series has no capacity: 100, a 1-2-5 step, or a binary step. */
export type MetricCeiling = "percent" | "decimal" | "binary";

export type MetricScale = Readonly<{
  /** `absolute`: the percentages turned into cores or bytes by each reading's capacity. */
  absolute: boolean;
  /** The readings in the drawn unit; null where the host reported nothing. */
  points: readonly MetricPoint[];
  /** The top of the chart: the largest capacity in the window for an absolute series, else found from the peak. */
  ceiling: number;
  /** A reading in a line of text: "1.3 cores", "4.9 GiB", "42 %", "1.2 MiB/s". */
  text: (value: number) => string;
  /** An axis label: as `text`, without trailing zeros. */
  tick: (value: number) => string;
  /** A stat: the value and, after it, the unit with the capacity of that reading's host. */
  reading: (value: number, capacity?: number) => MetricReading;
  /** The share of its host a reading took, for a tooltip; null unless the series is absolute. */
  share: (index: number) => string | null;
}>;

const KIB = 1024;
const GIB = KIB ** 3;

/** The series' name in the console's language; an id the catalogue does not know keeps the server's label. */
export function seriesLabel(series: Readonly<{ id: string; label: string }>): string {
  switch (series.id) {
    case "cpu": return t("metrics.cpu");
    case "memory": return t("metrics.memory");
    case "networkIn": return t("metrics.network");
    case "networkOut": return t("metrics.networkOut");
    default: return series.label;
  }
}

const numbers = new Map<string, Intl.NumberFormat>();

/** A number in the console's locale with exactly `fixed` decimals, or up to `fixed` when `trim`. */
function number(value: number, fixed: number, trim = false): string {
  const key = `${intlLocale()}:${fixed}:${trim}`;
  let format = numbers.get(key);
  if (!format) {
    format = new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: trim ? 0 : fixed, maximumFractionDigits: fixed });
    numbers.set(key, format);
  }
  return format.format(value);
}

/** Bytes in binary units, the unit chosen by the value (or by `power` when given). */
export function byteReading(bytes: number, options: Readonly<{ rate?: boolean; trim?: boolean; power?: number; decimals?: number }> = {}): MetricReading {
  const power = options.power ?? bytePower(bytes);
  const unit = byteUnit(power);
  return {
    value: number(bytes / KIB ** power, options.decimals ?? BYTE_DECIMALS[power]!, options.trim),
    unit: options.rate ? t("metrics.perSecond", { unit }) : unit,
  };
}

const joined = (reading: MetricReading) => `${reading.value} ${reading.unit}`;

/** A whole number for an axis: 1, 2, 4, 6, 8, 12 … 768 of a binary unit, so every label and its half read round. */
const BINARY_STEPS = [1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024] as const;

/** The top of a byte axis: the smallest binary step at or above the peak. */
export function binaryCeiling(peak: number): number {
  if (peak <= 0) return 1;
  const base = KIB ** Math.max(0, Math.floor(Math.log(peak) / Math.log(KIB)));
  return (BINARY_STEPS.find((step) => step * base >= peak) ?? 1024) * base;
}

/** The top of a plain axis: the peak rounded up to 1, 2 or 5 of its power of ten. */
export function decimalCeiling(peak: number): number {
  if (peak <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(peak));
  return ([1, 2, 5, 10].find((factor) => factor * power >= peak) ?? 10) * power;
}

/**
 * The plural count for a number as it is shown. A shown fraction ("1,0",
 * "2.5") takes the fractional form in every language ("1,0 ядра", "1.0
 * cores"), so it is counted as a fraction; a whole number counts as itself.
 */
function shownCount(value: string): Readonly<{ count: number; value: string }> {
  const fraction = /\d[.,]\d/.test(value);
  return { count: fraction ? 0.5 : Number(value.replace(/\D/g, "")), value };
}

const percentText = (value: number) => `${number(value, 0)} %`;

/** Whether the series reads as an absolute: a percentage, a unit for its capacity, and a capacity on every reading. */
export function isAbsolute(series: HostMetricSeries): boolean {
  if (series.unit !== "percent" || series.capacityUnit === undefined) return false;
  const known = series.points.filter((point) => point.value !== null);
  return known.length > 0 && known.every((point) => point.capacity !== undefined && point.capacity > 0);
}

const peakOf = (points: readonly MetricPoint[]) => Math.max(0, ...points.map((point) => point.value ?? 0));

export function metricScale(series: HostMetricSeries): MetricScale {
  const absolute = isAbsolute(series);
  const points: MetricPoint[] = series.points.map((point) => ({
    at: point.at,
    value: point.value === null ? null : absolute ? (point.value / 100) * point.capacity! : point.value,
    ...(point.interpolated ? { interpolated: true } : {}),
  }));
  const share = (index: number) => {
    const value = series.points[index]?.value;
    return absolute && value != null ? t("metrics.shareOfHost", { value: number(value, 0) }) : null;
  };
  const unit = absolute ? series.capacityUnit! : series.unit;
  const capacities = series.points.map((point) => point.capacity ?? 0);
  const latestCapacity = [...series.points].reverse().find((point) => point.value !== null)?.capacity;

  if (unit === "cores") {
    const ceiling = absolute ? Math.max(...capacities) : decimalCeiling(peakOf(points));
    const text = (value: number) => t("metrics.cores", shownCount(number(value, 1)));
    return {
      absolute, points, ceiling, share,
      text,
      tick: (value) => t("metrics.cores", shownCount(number(value, 1, true))),
      reading: (value, capacity = latestCapacity ?? 0) => ({ value: number(value, 1), unit: t("metrics.ofCores", shownCount(number(capacity, 1, true))) }),
    };
  }

  if (unit === "bytes" && absolute) {
    // One unit for the whole series, from its largest host: GiB on any host of a gibibyte or more.
    const ceiling = Math.max(...capacities);
    const power = ceiling >= GIB ? 3 : 2;
    return {
      absolute, points, ceiling, share,
      text: (value) => joined(byteReading(value, { power, decimals: 1 })),
      tick: (value) => joined(byteReading(value, { power, decimals: 1, trim: true })),
      reading: (value, capacity = latestCapacity ?? 0) => {
        const amount = byteReading(value, { power, decimals: 1 });
        return { value: amount.value, unit: t("metrics.ofCapacity", { unit: amount.unit, capacity: joined(byteReading(capacity, { power, decimals: 1, trim: true })) }) };
      },
    };
  }

  if (unit === "bytes" || unit === "bytesPerSecond") {
    const rate = unit === "bytesPerSecond";
    const ceiling = binaryCeiling(peakOf(points));
    return {
      absolute, points, ceiling, share,
      text: (value) => joined(byteReading(value, { rate })),
      tick: (value) => joined(byteReading(value, { rate, trim: true, decimals: 2 })),
      reading: (value) => byteReading(value, { rate }),
    };
  }

  if (unit === "percent") {
    // A percentage of a host whose size is not known for every reading: said as such.
    return {
      absolute, points, share,
      ceiling: 100,
      text: percentText,
      tick: percentText,
      reading: (value) => ({ value: number(value, 0), unit: t("metrics.percentOfHost") }),
    };
  }

  // A unit this console does not know yet: bare numbers.
  const plain = (value: number) => number(value, 1, true);
  return { absolute, points, share, ceiling: decimalCeiling(peakOf(points)), text: plain, tick: plain, reading: (value) => ({ value: plain(value), unit: "" }) };
}
