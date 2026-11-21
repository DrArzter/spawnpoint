import type { Detail, DetailKey, WorldModel } from "../../../core/models";
import { useMediaQuery } from "../../../shell/hooks";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { DetailList } from "../ui/DetailList";
import { Empty } from "../ui/Empty";
import { Grid } from "../ui/Grid";
import { TrackList, TrackTitle } from "../ui/TrackList";
import { Elapsed } from "./Hero";

/** The overflow items the World card draws instead of the header menu. */
export const CARD_ACTIONS: readonly string[] = ["world.settings", "world.game-settings"];

// The header pill shows the state and the top bar the observed time; while the
// hero shows, it holds the players and the uptime, which says what Launched says (R3).
const SHOWN_ELSEWHERE: readonly DetailKey[] = ["session", "observed"];
const IN_HERO: readonly DetailKey[] = ["players", "launched"];

/** The release as it runs now: the promotion notice names the desired one. */
function activeOnly(details: readonly Detail[]): Detail[] {
  return details.map((detail) => detail.value.type === "release" ? { ...detail, value: { ...detail.value, desired: detail.value.active } } : detail);
}

export function DetailsTab({ model }: Readonly<{ model: WorldModel }>) {
  const live = model.glance?.live;
  const hidden = live ? [...SHOWN_ELSEWHERE, ...IN_HERO] : SHOWN_ELSEWHERE;
  const session = model.sessionDetails.filter((detail) => detail.key === undefined || !hidden.includes(detail.key));
  const omit: DetailKey[] = [];
  if (model.availability.kind === "ready") omit.push("availability");
  if (live) omit.push("address");
  const settings = model.more.filter((item) => CARD_ACTIONS.includes(item.id));
  // Spec §6.3.1: on a phone the card head keeps its title and shows these as icons, named and tooltipped by their labels.
  const phone = useMediaQuery("(max-width: 759px)");
  return (
    <>
      <Grid kind="detail">
        {live === false
          ? <Empty icon="power_settings_new" size="sm" title="No session" />
          : session.length > 0 && <Card body="kv" title="Session"><DetailList columns="two" details={session} /></Card>}
        <Card actions={settings.length > 0 ? settings.map((item) => <ActionButton action={item} iconOnly={phone} key={item.id} size="sm" />) : undefined} body="kv" title="World">
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
