import type { ReactNode } from "react";

import type { HostMetrics } from "../../api/contract";
import { ChoiceChip } from "../../components/ui/Chip";
import { Skeleton } from "../../components/ui/Skeleton";
import { Sparkline } from "../../components/ui/Sparkline";
import { Banner, Card, EmptyState, NotConnected } from "../../components/ui/Surfaces";
import { Timestamp } from "../../components/ui/Timestamp";
import type { MetricsModel } from "../../core/models";
import { Icon } from "../../icons";
import { formatBytes } from "../../lib/format";
import { ActionButton } from "./actions";

export const formatMetric = (unit: string) => (value: number) => (unit === "percent" ? `${value.toFixed(1)}%` : formatBytes(value));

// One world's host, measured (ADR-0062): never the first host in a list.
// Which chart draws the numbers is the skin's choice, so it comes in as a
// function; the terminal draws its own wells.
export function MetricsPanel({ model }: Readonly<{ model: MetricsModel }>) {
  return <MetricsCard chart={sparkChart} model={model} />;
}

export function MetricsCard({ model, chart, placeholder }: Readonly<{ model: MetricsModel; chart: (metrics: HostMetrics) => ReactNode; placeholder?: ReactNode }>) {
  const metrics = model.metrics;
  if (metrics.status === "error" && metrics.kind === "unavailable") {
    return <Card flush><NotConnected title="CloudWatch is not connected yet" /></Card>;
  }
  if (metrics.status === "ready" && metrics.value === null) {
    return <Card flush><EmptyState description="Metrics show the host this world's session runs on. Start the world to see them." icon="bar_chart" title="No host right now" /></Card>;
  }
  return (
    <Card
      actions={<fieldset className="chip-row fieldset-plain">
        <legend className="visually-hidden">Window</legend>
        {model.ranges.map((option) => <ChoiceChip key={option.id} onClick={() => model.setRange(option.id)} pressed={model.range === option.id}>{option.label}</ChoiceChip>)}
      </fieldset>}
      title="Host this world runs on"
    >
      {metrics.status === "error" && <Banner actions={<ActionButton action={metrics.retry} variant="text" />} description={metrics.error} title="Metrics could not be loaded" tone="error" />}
      {metrics.status === "loading" && (placeholder ?? <MetricsSkeleton />)}
      {metrics.status === "ready" && metrics.value !== null && chart(metrics.value)}
    </Card>
  );
}

export function seriesPeak(points: readonly Readonly<{ value: number | null }>[]): number | null {
  const known = points.filter((point) => point.value !== null);
  return known.length > 0 ? Math.max(...known.map((point) => point.value ?? 0)) : null;
}

const metricLabels = ["CPU", "Network in", "Network out"] as const;

function MetricsSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="page">
      <span className="visually-hidden">Reading CloudWatch metrics</span>
      {metricLabels.map((label) => <section aria-hidden="true" className="spark-row" key={label}>
        <div className="spark-head"><strong>{label}</strong><Skeleton width="88px" /></div>
        <Skeleton height={68} />
      </section>)}
      <div aria-hidden="true" className="scale"><Skeleton width="104px" /><Skeleton width="104px" /></div>
    </div>
  );
}

function sparkChart(metrics: HostMetrics): ReactNode {
  return (
    <>
      {metrics.series.map((series) => {
        const peak = seriesPeak(series.points);
        return (
          <section className="spark-row" key={series.id}>
            <div className="spark-head">
              <strong>{series.label}</strong>
              <span>{peak === null ? "no data in this window" : `peak ${formatMetric(series.unit)(peak)}`}</span>
            </div>
            {series.points.filter((point) => point.value !== null).length > 1
              ? <Sparkline format={formatMetric(series.unit)} label={series.label} points={series.points} />
              : <p className="secondary"><Icon name="do_not_disturb_on" size={16} /> The host reported nothing in this window.</p>}
          </section>
        );
      })}
      {/* One window, one scale. Repeating it under every line said three times
          what is true once. */}
      <div className="scale">
        <Timestamp value={metrics.startedAt} />
        <Timestamp value={metrics.endedAt} />
      </div>
    </>
  );
}
