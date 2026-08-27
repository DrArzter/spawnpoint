import assert from "node:assert/strict";
import test from "node:test";

import { renderAlert } from "../src/domain/alerts.ts";

test("a CloudWatch alarm renders with its state and reason", () => {
  const alarm = renderAlert({
    subject: 'ALARM: "spawnpoint-running-hours" in EU (Frankfurt)',
    message: JSON.stringify({
      AlarmName: "spawnpoint-running-hours",
      NewStateValue: "ALARM",
      NewStateReason: "Threshold Crossed: 10 datapoints were greater than the threshold (-1.0).",
    }),
  });
  assert.match(alarm, /\[ALARM\] spawnpoint-running-hours/);
  assert.match(alarm, /10 datapoints/);

  const recovered = renderAlert({
    subject: null,
    message: JSON.stringify({ AlarmName: "spawnpoint-running-hours", NewStateValue: "OK" }),
  });
  assert.match(recovered, /\[OK\] spawnpoint-running-hours/);
});

test("a cost anomaly renders with its impact and link", () => {
  const rendered = renderAlert({
    subject: null,
    message: JSON.stringify({
      anomalyDetailsLink: "https://console.aws.amazon.com/cost-management/home#/anomaly-detection/x",
      impact: { totalImpact: 7.5 },
    }),
  });
  assert.match(rendered, /\[COST\]/);
  assert.match(rendered, /\$7\.50/);
  assert.match(rendered, /anomaly-detection/);
});

test("budgets prose and anything unrecognised are delivered, never dropped", () => {
  const budget = renderAlert({
    subject: "AWS Budgets: spawnpoint-monthly has exceeded your alert threshold",
    message: "Dear AWS Customer, your actual spend has exceeded 100% of the limit...",
  });
  assert.match(budget, /\[ALERT\] AWS Budgets: spawnpoint-monthly/);
  assert.match(budget, /actual spend/);

  const garbage = renderAlert({ subject: null, message: "{not json at all" });
  assert.match(garbage, /\[ALERT\] Alert/);
  assert.match(garbage, /not json at all/);

  const longMessage = renderAlert({ subject: "x", message: "a".repeat(2000) });
  assert.ok(longMessage.length < 700, "long alerts are clipped for chat");
});
