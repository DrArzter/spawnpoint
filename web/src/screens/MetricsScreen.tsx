import { ServerState } from "../model";
import { Tabs } from "../components/ui/Tabs";
import { useState } from "react";

export function MetricsScreen({ serverState }: { serverState: ServerState }) {
  const [source, setSource] = useState<"session" | "cloudwatch">("session");
  return <>
    <div className="page-heading"><h1>Metrics</h1><p>Live session data and durable AWS signals</p></div>
    <Tabs label="Metric source" onChange={setSource} options={[{ id: "session", label: "Session" }, { id: "cloudwatch", label: "CloudWatch" }]} value={source} />
    {source === "session" && <div className="empty-state"><strong>{serverState === "running" ? "Session telemetry is not connected yet" : "No active session telemetry"}</strong><p>{serverState === "running" ? "The host is running, but Spawnpoint does not yet have a trusted Prometheus or Grafana endpoint for this session." : "Prometheus and Grafana will run only with an active game session. The metrics API is a later control-plane slice."}</p></div>}
    {source === "cloudwatch" && <div className="empty-state"><strong>CloudWatch is not connected yet</strong><p>Durable alarms and historical metrics will appear here after the control-plane API is wired to CloudWatch.</p></div>}
  </>;
}
