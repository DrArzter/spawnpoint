// SNS alert rendering: the guardrails topic carries three different senders —
// CloudWatch alarms (JSON), AWS Budgets (plain text), Cost Anomaly Detection
// (JSON) — and whatever future service is granted a statement on the topic.
// The one hard rule: an alert must never be lost to a parse error. Anything
// unrecognised is delivered raw, not thrown.

export type SnsAlert = Readonly<{
  subject: string | null;
  message: string;
}>;

const tryJson = (raw: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(raw);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const clip = (text: string, max = 600): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export function renderAlert(alert: SnsAlert): string {
  const parsed = tryJson(alert.message);

  // CloudWatch alarm state change.
  if (parsed && typeof parsed.AlarmName === "string" && typeof parsed.NewStateValue === "string") {
    const icon = parsed.NewStateValue === "ALARM" ? "🚨" : parsed.NewStateValue === "OK" ? "✅" : "❔";
    const reason = typeof parsed.NewStateReason === "string" ? `\n${clip(parsed.NewStateReason, 300)}` : "";
    return `${icon} ${parsed.AlarmName}: ${parsed.NewStateValue}${reason}`;
  }

  // Cost Anomaly Detection.
  if (parsed && (parsed.anomalyDetailsLink !== undefined || parsed.impact !== undefined)) {
    const impact = parsed.impact as Record<string, unknown> | undefined;
    const dollars =
      impact && typeof impact.totalImpact === "number" ? ` about $${impact.totalImpact.toFixed(2)}` : "";
    const link = typeof parsed.anomalyDetailsLink === "string" ? `\n${parsed.anomalyDetailsLink}` : "";
    return `💸 Cost anomaly detected —${dollars || " see details"}.${link}`;
  }

  // AWS Budgets sends prose; so does anything unrecognised. Deliver, never drop.
  const subject = alert.subject ?? "Alert";
  return `🔔 ${subject}\n${clip(alert.message)}`;
}
