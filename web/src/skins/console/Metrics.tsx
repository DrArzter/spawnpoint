import type { ReactNode } from "react";

import type { HostMetrics } from "../../api/contract";
import { ChoiceChip } from "../../components/ui/Chip";
import { Skeleton } from "../../components/ui/Skeleton";
import { Sparkline } from "../../components/ui/Sparkline";
import { Banner, Card, EmptyState, NotConnected } from "../../components/ui/Surfaces";
import { Tabs } from "../../components/ui/Tabs";
import { Timestamp } from "../../components/ui/Timestamp";
import type { MetricsModel } from "../../core/models";
import { Icon } from "../../icons";
import { formatBytes } from "../../lib/format";
import { ActionButton } from "./actions";

export const formatMetric = (unit: string) => (value: number) => (unit === "percent" ? `${value.toFixed(1)}%` : formatBytes(value));

export function Metrics({ model }: Readonly<{ model: MetricsModel }>) {
  return <MetricsPage chart={sparkChart} model={model} />;
}

// The page around a chart: source tabs, the window chips, the states before
// there is anything to draw. Which chart draws the numbers is the skin's
// choice, so it comes in as a function.
export function MetricsPage({ model, chart, placeholder }: Readonly<{ model: MetricsModel; chart: (metrics: HostMetrics) => ReactNode; placeholder?: ReactNode }>) {
  return (
    <div className="page">
      <h1 className="visually-hidden">Metrics</h1>
      <Tabs label="Metric source" onChange={model.setSource} options={[{ id: "cloudwatch", label: "CloudWatch", icon: "cloud" }, { id: "session", label: "Session", icon: "bar_chart" }]} value={model.source} />
      {model.source === "cloudwatch" && <HostChart chart={chart} model={model} placeholder={placeholder} />}
      {/* The stack that answers this already runs beside the game — node-exporter,
          cAdvisor, Prometheus and Grafana, session-scoped. What is missing is the
          path from a host on a private overlay to a public panel, so this stays
          closed rather than empty. */}
      {model.source === "session" && <Card flush><NotConnected
        description={model.online ? "Prometheus and Grafana are running beside this session, on a host the panel cannot reach yet. Charts appear once a path out of the overlay exists." : "Prometheus and Grafana run inside an active game session, and the path that would carry them to this page does not exist yet."}
        title="Session telemetry is not connected yet"
      /></Card>}
    </div>
  );
}

function HostChart({ model, chart, placeholder }: Readonly<{ model: MetricsModel; chart: (metrics: HostMetrics) => ReactNode; placeholder?: ReactNode }>) {
  if (model.instanceId === undefined) {
    return <Card flush><EmptyState description="Metrics are read from the compute host, and the control plane reports none right now." icon="bar_chart" title="No host to measure" /></Card>;
  }
  const metrics = model.metrics;
  if (metrics.status === "error" && metrics.kind === "unavailable") {
    return <Card flush><NotConnected description="Host metrics appear here once the control plane reads CloudWatch." title="CloudWatch is not connected yet" /></Card>;
  }
  return (
    <Card
      actions={<fieldset className="chip-row fieldset-plain">
        <legend className="visually-hidden">Window</legend>
        {model.ranges.map((option) => <ChoiceChip key={option.id} onClick={() => model.setRange(option.id)} pressed={model.range === option.id}>{option.label}</ChoiceChip>)}
      </fieldset>}
      title="Compute host"
    >
      {metrics.status === "error" && <Banner actions={<ActionButton action={metrics.retry} variant="text" />} description={metrics.error} title="Metrics could not be loaded" tone="error" />}
      {metrics.status === "loading" && (placeholder ?? <div className="page">{model.ranges.map((option) => <Skeleton height={68} key={option.id} />)}</div>)}
      {metrics.status === "ready" && chart(metrics.value)}
    </Card>
  );
}

export function seriesPeak(points: readonly Readonly<{ value: number | null }>[]): number | null {
  const known = points.filter((point) => point.value !== null);
  return known.length > 0 ? Math.max(...known.map((point) => point.value ?? 0)) : null;
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
