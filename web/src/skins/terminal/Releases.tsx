import type { PointerRow, PresetRow, ReleasesModel } from "../../core/models";
import { Icon } from "../../icons";
import { commitUrl, repositoryName, shortCommit } from "../../lib/format";
import { Col, Empty, Ghost, Indicator, Overflow, Page, Panel, Table } from "./ui";
import { t } from "../../i18n";

const SHOWN_RELEASES = 3;

export function Releases({ model }: Readonly<{ model: ReleasesModel }>) {
  const presetColumns: readonly Col<PresetRow>[] = [
    { id: "preset", label: t("common.preset"), width: "26%", render: (row) => <strong>{row.preset.displayName}</strong> },
    { id: "build", label: t("common.build"), width: "96px", render: (row) => <span className="t-inline"><Indicator kind={row.status.kind} label={row.preset.build && !row.revision ? t("releases.statusLabelReleaseAttemptAttempt", { statusLabel: row.status.label, release: row.preset.build.release, attempt: row.preset.build.attempt }) : row.status.label} />{row.revision && <Indicator kind={row.revision.kind} label={row.preset.build ? t("releases.statusLabelReleaseAttemptAttempt", { statusLabel: row.revision.label, release: row.preset.build.release, attempt: row.preset.build.attempt }) : row.revision.label} />}</span> },
    { id: "latest", label: t("releases.latestBuild"), width: "14%", render: (row) => (row.preset.latestRelease ? <code title={t("releases.immutableBuildIDNot")}>{row.preset.latestRelease}</code> : <Ghost>{t("releases.noneYet")}</Ghost>) },
    // The newest few, then a count: a preset accumulates releases forever.
    {
      id: "releases",
      label: t("common.releases"),
      secondary: true,
      optional: true,
      width: "22%",
      render: ({ preset }) => {
        if (preset.releases.length === 0) return <Ghost>{t("releases.noReleasesBuilt")}</Ghost>;
        const newest = [...preset.releases].reverse();
        const shown = newest.slice(0, SHOWN_RELEASES);
        const rest = newest.length - shown.length;
        return (
          <span className="t-release-list" title={newest.join(", ")}>
            {shown.map((release) => <code className={release === preset.latestRelease ? "t-tag t-tag-primary" : "t-tag"} key={release}>{release}</code>)}
            {rest > 0 && <small>+{rest}</small>}
          </span>
        );
      },
    },
    {
      id: "source",
      label: t("common.source"),
      width: "12%",
      render: ({ preset }) => (
        <a className="t-source" href={commitUrl(preset.repository, preset.commit)} rel="noreferrer" target="_blank" title={`${repositoryName(preset.repository)} @ ${preset.commit}`}>
          <code>{shortCommit(preset.commit)}</code>
          <Icon name="open_in_new" size={14} />
        </a>
      ),
    },
    { id: "verbs", label: t("common.actions"), verbs: true, corner: true, render: (row) => <Overflow groups={[[...(row.build ? [row.build] : []), ...(row.createWorld ? [row.createWorld] : [])]]} label={t("common.actionsMemberName", { memberName: row.preset.displayName })} size="small" /> },
  ];
  const pointerColumns: readonly Col<PointerRow>[] = [
    { id: "world", label: t("common.world"), width: "26%", render: (row) => <span className="t-inline"><a className="t-row-link" href={row.href}>{row.world.displayName}</a><Indicator kind={row.world.release.activeRelease === row.world.release.desiredRelease ? "ok" : "pending"} label={row.summary} /></span> },
    { id: "preset", label: t("common.preset"), width: "22%", render: (row) => row.presetName },
    { id: "active", label: t("releases.runningBuild"), width: "140px", render: ({ world }) => (world.release.activeRelease ? <code title={t("releases.immutableBuildIDNot")}>{world.release.activeRelease}</code> : <Ghost>{t("releases.notStarted")}</Ghost>) },
    { id: "desired", label: t("releases.nextBuild"), width: "140px", render: ({ world }) => (world.release.desiredRelease ? <code title={t("releases.immutableBuildIDNot")}>{world.release.desiredRelease}</code> : <Ghost>{t("releases.noneSelected")}</Ghost>) },
  ];
  const title = model.game ? t("releases.presetsGameDisplayName", { gameDisplayName: model.game.displayName }) : t("releases.presets");
  return (
    <Page>
      <h1 className="visually-hidden">{t("common.releases")}</h1>
      <Panel flush name={title}>
        <Table columns={presetColumns} empty={<Empty title={t("releases.noPresets")} />} label={title} loading={model.loading} rowKey={(row) => row.preset.id} rows={model.presets} />
      </Panel>
      <Panel flush name={t("releases.releasePointers")}>
        <Table columns={pointerColumns} empty={<Empty title={t("common.noWorlds")} />} label={t("releases.releasePointersByWorld")} loading={model.loading} rowKey={(row) => row.world.id} rows={model.pointers} />
      </Panel>
    </Page>
  );
}
