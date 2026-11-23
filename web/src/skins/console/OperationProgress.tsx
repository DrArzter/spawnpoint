import type { OperationProgressModel } from "../../core/models";
import { progressDetails, useSecondClock } from "../../core/operation-progress";
import { Card } from "./ui/Card";
import { DetailList } from "./ui/DetailList";
import { HostLog } from "./ui/HostLog";
import { Status } from "./ui/Status";

// A cause and its error read across the card, not in one column.
const SPANS = { Cause: "w2", "Caught cause": "w2" } as const;

/**
 * The world's running operation, or the one that just failed: its step, how
 * long it has run and what it usually takes, then the cause if it failed. It
 * holds the session's place on the Details tab while it shows.
 */
export function OperationProgress({ model }: Readonly<{ model: OperationProgressModel }>) {
  const now = useSecondClock(model.running);
  return (
    <Card actions={<Status status={model.status} />} body="kv" title={model.title}>
      <DetailList columns="two" details={progressDetails(model, now)} label={`${model.title}: ${model.status.label}`} spans={SPANS} />
      {(model.log.length > 0 || (model.running && model.logged)) && <HostLog label={`${model.title}: host log`} live={model.running} rows={model.log} />}
    </Card>
  );
}
