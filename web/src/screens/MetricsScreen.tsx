import { useState } from "react";

import { Card, EmptyState, PageHeader } from "../components/ui/Surfaces";
import { Tabs } from "../components/ui/Tabs";
import type { Game, ServerState } from "../model";

export function MetricsScreen({ game, serverState }: { game: Game | undefined; serverState: ServerState }) {
  const [source, setSource] = useState<"session" | "cloudwatch">("session");
  const online = serverState === "running";
  return (
    <div className="page">
      <PageHeader description={`Live session telemetry and durable AWS signals for ${game?.displayName ?? "the selected game"}.`} title="Metrics" />
      <Tabs label="Metric source" onChange={setSource} options={[{ id: "session", label: "Session", icon: "bar_chart" }, { id: "cloudwatch", label: "CloudWatch", icon: "cloud" }]} value={source} />
      <Card flush>
        {source === "session" && <EmptyState
          description={online ? "The host is running, but Spawnpoint has no trusted Prometheus or Grafana endpoint for this session yet. Charts appear once the metrics API is wired." : "Prometheus and Grafana run only inside an active game session. Start a session from Worlds, then telemetry becomes available here once the metrics API is wired."}
          icon="bar_chart"
          title={online ? "Session telemetry is not connected yet" : "No active session telemetry"}
        />}
        {source === "cloudwatch" && <EmptyState description="Durable alarms and historical host metrics will appear here after the control-plane API is connected to CloudWatch." icon="cloud" title="CloudWatch is not connected yet" />}
      </Card>
    </div>
  );
}
