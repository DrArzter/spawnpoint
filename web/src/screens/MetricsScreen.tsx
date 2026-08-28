import { Icon } from "../Icon";
import { ServerState } from "../model";
import { Button } from "../components/ui/Button";
import { Tabs } from "../components/ui/Tabs";
import { useState } from "react";

const series = ["3,45 18,39 33,42 48,29 63,34 78,18 93,25 108,15 123,20 138,8 153,17 168,12", "3,38 18,37 33,31 48,34 63,27 78,30 93,22 108,24 123,16 138,20 153,13 168,15"];

export function MetricsScreen({ serverState }: { serverState: ServerState }) {
  const [source, setSource] = useState<"session" | "cloudwatch">("session");
  return <>
    <div className="page-heading action-heading"><div><h1>Metrics</h1><p>Live session data and durable AWS signals</p></div><Button disabled icon={<Icon name="external" />} title="Grafana becomes available when its session URL is connected">Grafana not connected</Button></div>
    {serverState !== "running" && <div className="info-banner"><strong>Session metrics are paused.</strong><span>Prometheus and Grafana start together with the game server. Historical CloudWatch data remains available.</span></div>}
    <Tabs label="Metric source" onChange={setSource} options={[{ id: "session", label: "Session" }, { id: "cloudwatch", label: "CloudWatch" }]} value={source} />
    {source === "session" && serverState === "running" && <section className="chart-grid">
      <Chart label="Minecraft CPU" value={serverState === "running" ? "18.7%" : "No data"} points={series[0]} />
      <Chart label="Minecraft memory" value={serverState === "running" ? "5.86 GiB" : "No data"} points={series[1]} />
      <Chart label="Host memory" value={serverState === "running" ? "74.5%" : "No data"} points={series[1]} />
      <Chart label="Response time" value={serverState === "running" ? "1.6 ms" : "No data"} points={series[0]} />
    </section>}
    {source === "session" && serverState !== "running" && <div className="empty-state"><strong>No active session</strong><p>Start the selected world to launch Prometheus and Grafana and begin collecting live metrics.</p></div>}
    {source === "cloudwatch" && <div className="empty-state"><strong>CloudWatch is not connected yet</strong><p>Durable alarms and historical metrics will appear here after the control-plane API is wired to CloudWatch.</p></div>}
  </>;
}

function Chart({ label, value, points }: { label: string; value: string; points: string }) {
  return <article className="chart"><div><p>{label}</p><strong>{value}</strong></div><svg aria-hidden="true" viewBox="0 0 172 52" preserveAspectRatio="none"><path d="M3 50H169" /><polyline points={points} /></svg><footer><span>30 minutes ago</span><span>Now</span></footer></article>;
}
