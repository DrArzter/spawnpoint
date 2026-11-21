import type { Detail, DetailKey, WorldModel } from "../../../core/models";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { DetailList } from "../ui/DetailList";
import { Empty } from "../ui/Empty";
import { Grid } from "../ui/Grid";
import { TrackList, TrackTitle } from "../ui/TrackList";
import { Elapsed } from "./Hero";

/** The overflow items the World card draws instead of the header menu. */
export const CARD_ACTIONS: readonly string[] = ["world.settings", "world.game-settings"];

// The header pill shows the state, the hero the players, the top bar the observed time (R3).
const SHOWN_ELSEWHERE: readonly DetailKey[] = ["session", "players", "observed"];

/** The release as it runs now: the promotion notice names the desired one. */
function activeOnly(details: readonly Detail[]): Detail[] {
  return details.map((detail) => detail.value.type === "release" ? { ...detail, value: { ...detail.value, desired: detail.value.active } } : detail);
}

export function DetailsTab({ model }: Readonly<{ model: WorldModel }>) {
  const live = model.glance?.live;
  const session = model.sessionDetails.filter((detail) => detail.key === undefined || !SHOWN_ELSEWHERE.includes(detail.key));
  const omit: DetailKey[] = [];
  if (model.availability.kind === "ready") omit.push("availability");
  if (live) omit.push("address");
  const settings = model.more.filter((item) => CARD_ACTIONS.includes(item.id));
  return (
    <>
      <Grid kind="detail">
        {live === false
          ? <Card label="Session"><Empty icon="stop_circle" size="sm" title="No session" /></Card>
          : session.length > 0 && <Card body="kv" title="Session"><DetailList columns="two" details={session} /></Card>}
        <Card actions={settings.length > 0 ? settings.map((item) => <ActionButton action={item} key={item.id} size="sm" />) : undefined} body="kv" title="World">
          <DetailList columns="two" details={activeOnly(model.worldDetails)} omit={omit} />
        </Card>
      </Grid>
      {model.operations.length > 0 && (
        <Card body="flush" count={model.operations.length} title="Operations">
          <TrackList
            label="Operations"
            rowKey={(row) => row.operation.id}
            rows={model.operations}
            tracks={[
              { id: "operation", header: "Operation", width: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle line={<span className="c-mono">{row.operation.id}</span>} title={row.label} /> },
              { id: "running", header: "Running for", width: "120px", kind: "num", render: (row) => <Elapsed since={row.operation.startedAt} /> },
            ]}
          />
        </Card>
      )}
    </>
  );
}
