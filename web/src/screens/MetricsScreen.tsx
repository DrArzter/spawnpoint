import { useEffect, useState } from "react";

import type { ApiFailureKind, HostMetrics, MetricRange } from "../api/contract";
import { failureKind } from "../api/contract";
import { loadHostMetrics } from "../auth";
import { Button } from "../components/ui/Button";
import { ChoiceChip } from "../components/ui/Chip";
import { Skeleton } from "../components/ui/Skeleton";
import { Sparkline } from "../components/ui/Sparkline";
import { Banner, Card, EmptyState, NotConnected } from "../components/ui/Surfaces";
import { Tabs } from "../components/ui/Tabs";
import { Timestamp } from "../components/ui/Timestamp";
import { Icon } from "../icons";
import { formatBytes } from "../lib/format";
import type { ControlPlaneSnapshot, Game, ServerState } from "../model";

const RANGES: readonly { id: MetricRange; label: string }[] = [
  { id: "6h", label: "6 hours" },
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
];

const formatValue = (unit: string) => (value: number) =>
  unit === "percent" ? `${value.toFixed(1)}%` : formatBytes(value);

export function MetricsScreen({ game, snapshot, serverState }: { game: Game | undefined; snapshot: ControlPlaneSnapshot | null; serverState: ServerState }) {
  const [source, setSource] = useState<"session" | "cloudwatch">("cloudwatch");
  const online = serverState === "running";
  return (
    <div className="page">
      <h1 className="visually-hidden">Metrics</h1>
      <Tabs label="Metric source" onChange={setSource} options={[{ id: "cloudwatch", label: "CloudWatch", icon: "cloud" }, { id: "session", label: "Session", icon: "bar_chart" }]} value={source} />
      {source === "cloudwatch" && <HostChart instanceId={snapshot?.hosts[0]?.id} />}
      {/* The stack that answers this already runs beside the game — node-exporter,
          cAdvisor, Prometheus and Grafana, session-scoped. What is missing is the
          path from a host on a private overlay to a public panel, so this stays
          closed rather than empty. */}
      {source === "session" && <Card flush><NotConnected
        description={online ? "Prometheus and Grafana are running beside this session, on a host the panel cannot reach yet. Charts appear once a path out of the overlay exists." : "Prometheus and Grafana run inside an active game session, and the path that would carry them to this page does not exist yet."}
        title="Session telemetry is not connected yet"
      /></Card>}
    </div>
  );
}

function HostChart({ instanceId }: Readonly<{ instanceId: string | undefined }>) {
  const [range, setRange] = useState<MetricRange>("24h");
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<ApiFailureKind>("failed");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (instanceId === undefined) return;
    let current = true;
    setMetrics(null);
    setError(null);
    loadHostMetrics(instanceId, range)
      .then((result) => { if (current) setMetrics(result); })
      .catch((cause: unknown) => {
        if (!current) return;
        setError(cause instanceof Error ? cause.message : "Host metrics could not be loaded.");
        setErrorKind(failureKind(cause));
      });
    return () => { current = false; };
  }, [instanceId, range, revision]);

  if (instanceId === undefined) {
    return <Card flush><EmptyState description="Metrics are read from the compute host, and the control plane reports none right now." icon="bar_chart" title="No host to measure" /></Card>;
  }
  if (error !== null && errorKind === "unavailable") {
    return <Card flush><NotConnected description="Host metrics appear here once the control plane reads CloudWatch." title="CloudWatch is not connected yet" /></Card>;
  }

  return (
    <Card
      actions={<div aria-label="Window" className="chip-row" role="group">
        {RANGES.map((option) => <ChoiceChip key={option.id} onClick={() => setRange(option.id)} pressed={range === option.id}>{option.label}</ChoiceChip>)}
      </div>}
      title="Compute host"
    >
      {error !== null && errorKind !== "unavailable" && <Banner actions={<Button onClick={() => setRevision((value) => value + 1)} variant="text">Try again</Button>} description={error} title="Metrics could not be loaded" tone="error" />}
      {error === null && metrics === null && <div className="page">{RANGES.map((option) => <Skeleton height={68} key={option.id} />)}</div>}
      {metrics !== null && metrics.series.map((series) => {
        const known = series.points.filter((point) => point.value !== null);
        const peak = known.length > 0 ? Math.max(...known.map((point) => point.value ?? 0)) : null;
        return (
          <section className="spark-row" key={series.id}>
            <div className="spark-head">
              <strong>{series.label}</strong>
              <span>{peak === null ? "no data in this window" : `peak ${formatValue(series.unit)(peak)}`}</span>
            </div>
            {known.length > 1
              ? <Sparkline format={formatValue(series.unit)} label={series.label} points={series.points} />
              : <p className="secondary"><Icon name="do_not_disturb_on" size={16} /> The host reported nothing in this window.</p>}
          </section>
        );
      })}
      {/* One window, one scale. Repeating it under every line said three times
          what is true once. */}
      {metrics !== null && <div className="scale">
        <Timestamp value={metrics.startedAt} />
        <Timestamp value={metrics.endedAt} />
      </div>}
    </Card>
  );
}
