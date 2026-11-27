import type { Detail, DetailKey, WorldModel } from "../../../core/models";
import { useMediaQuery } from "../../../shell/hooks";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { DetailList } from "../ui/DetailList";
import { Empty, LoadError } from "../ui/Empty";
import { Grid } from "../ui/Grid";
import { TrackList, TrackTitle } from "../ui/TrackList";
import { RunningTime } from "../ui/Flashbar";
import { OperationProgress } from "../OperationProgress";
import { t } from "../../../i18n";

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
    <Grid fill kind="detail">
      <SessionSlot details={session} live={live} model={model} />
      <Card actions={settings.length > 0 ? settings.map((item) => <ActionButton action={item} iconOnly={phone} key={item.id} size="sm" />) : undefined} body="kv" title={t("common.world")}>
        <DetailList columns="two" details={activeOnly(model.worldDetails)} omit={omit} />
      </Card>
      {model.backupOverview && <BackupCard model={model} overview={model.backupOverview} />}
      <Card body="flush" count={model.operations.length > 0 ? model.operations.length : undefined} title={t("world.activity")}>
        {model.operations.length === 0 ? <Empty icon="history" size="sm" title={t("world.nothingRunning")} /> : (
          <TrackList
            label={t("common.operations")}
            rowKey={(row) => row.operation.id}
            rows={model.operations}
            tracks={[
              { id: "operation", header: t("common.operation"), width: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle line={<span className="c-mono">{row.operation.id}</span>} title={row.label} /> },
              { id: "running", header: t("common.running2"), width: "auto", kind: "num", render: (row) => <RunningTime expectation={row.operation} since={row.operation.startedAt} /> },
            ]}
          />
        )}
      </Card>
    </Grid>
  );
}

/** The newest backup in a few facts, and the way to all of them. */
function BackupCard({ model, overview }: Readonly<{ model: WorldModel; overview: NonNullable<WorldModel["backupOverview"]> }>) {
  return (
    <Card actions={<ActionButton action={model.showBackups} size="sm" />} body="kv" title={t("world.latestBackup")}>
      {overview.status === "loading" && <DetailList columns="fit" details={[{ label: t("world.stored"), value: { type: "loading" } }, { label: t("common.size"), value: { type: "loading" } }]} />}
      {overview.status === "error" && <LoadError error={overview.error} kind={overview.kind} retry={overview.retry} size="sm" title={t("world.latestBackup")} verb={t("common.backups")} />}
      {overview.status === "ready" && (overview.value.length === 0 ? <Empty icon="cloud_off" size="sm" title={t("backups.noBackups")} /> : <DetailList columns="fit" details={overview.value} />)}
    </Card>
  );
}

function SessionSlot({ model, live, details }: Readonly<{ model: WorldModel; live: boolean | undefined; details: readonly Detail[] }>) {
  if (model.progress) return <OperationProgress model={model.progress} />;
  if (live === false) return <Card title={t("world.session")}><Empty icon="power_settings_new" size="sm" title={t("world.noSession")} /></Card>;
  return details.length > 0 ? <Card body="kv" title={t("world.session")}><DetailList columns="two" details={details} /></Card> : null;
}
