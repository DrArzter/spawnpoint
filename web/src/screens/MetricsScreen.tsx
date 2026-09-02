import { ServerState } from "../model";
import { Tabs } from "../components/ui/Tabs";
import { useState } from "react";
import { EmptyState, PageHeader } from "../components/ui/Page";

export function MetricsScreen({ serverState }: { serverState: ServerState }) {
  const [source, setSource] = useState<"session" | "cloudwatch">("session");
  return <>
    <PageHeader description="Live session data and durable AWS signals" title="Metrics" />
    <Tabs label="Metric source" onChange={setSource} options={[{ id: "session", label: "Session" }, { id: "cloudwatch", label: "CloudWatch" }]} value={source} />
    {source === "session" && <EmptyState description={serverState === "running" ? "The host is running, but Spawnpoint does not yet have a trusted Prometheus or Grafana endpoint for this session." : "Prometheus and Grafana will run only with an active game session. The metrics API is a later control-plane slice."} icon="metrics" title={serverState === "running" ? "Session telemetry is not connected yet" : "No active session telemetry"} />}
    {source === "cloudwatch" && <EmptyState description="Durable alarms and historical metrics will appear here after the control-plane API is wired to CloudWatch." icon="metrics" title="CloudWatch is not connected yet" />}
  </>;
}
