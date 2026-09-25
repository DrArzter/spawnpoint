import type { PointerRow, PresetRow, ReleasesModel } from "../../core/models";
import { Icon } from "../../icons";
import { commitUrl, repositoryName, shortCommit } from "../../lib/format";
import { Col, Empty, Ghost, Page, Panel, State, Table, Verb } from "./ui";

const SHOWN_RELEASES = 3;

export function Releases({ model }: Readonly<{ model: ReleasesModel }>) {
  const presetColumns: readonly Col<PresetRow>[] = [
    { id: "preset", label: "Preset", width: "26%", render: (row) => <strong>{row.preset.displayName}</strong> },
    { id: "build", label: "Build", width: "16%", render: (row) => <State kind={row.status.kind} label={row.status.label} /> },
    { id: "latest", label: "Latest build", width: "14%", render: (row) => (row.preset.latestRelease ? <code title="Immutable build ID, not the game version">{row.preset.latestRelease}</code> : <Ghost>None yet</Ghost>) },
    // The newest few, then a count: a preset accumulates releases forever.
    {
      id: "releases",
      label: "Releases",
      secondary: true,
      width: "22%",
      render: ({ preset }) => {
        if (preset.releases.length === 0) return <Ghost>No releases built</Ghost>;
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
      label: "Source",
      width: "12%",
      render: ({ preset }) => (
        <a className="t-source" href={commitUrl(preset.repository, preset.commit)} rel="noreferrer" target="_blank" title={`${repositoryName(preset.repository)} @ ${preset.commit}`}>
          <code>{shortCommit(preset.commit)}</code>
          <Icon name="open_in_new" size={14} />
        </a>
      ),
    },
    { id: "verbs", label: "Actions", verbs: true, render: (row) => (row.createWorld ? <Verb action={row.createWorld} size="small" /> : null) },
  ];
  const pointerColumns: readonly Col<PointerRow>[] = [
    { id: "world", label: "World", width: "26%", render: (row) => <a className="t-row-link" href={row.href}>{row.world.displayName}</a> },
    { id: "preset", label: "Preset", width: "22%", render: (row) => row.presetName },
    { id: "active", label: "Running build", width: "140px", render: ({ world }) => (world.release.activeRelease ? <code title="Immutable build ID, not the game version">{world.release.activeRelease}</code> : <Ghost>Not started</Ghost>) },
    { id: "desired", label: "Next build", width: "140px", render: ({ world }) => (world.release.desiredRelease ? <code title="Immutable build ID, not the game version">{world.release.desiredRelease}</code> : <Ghost>None selected</Ghost>) },
    { id: "pointer", label: "Status", render: (row) => <span>{row.summary}</span> },
  ];
  const title = model.game ? `Presets of ${model.game.displayName}` : "Presets";
  return (
    <Page>
      <h1 className="visually-hidden">Releases</h1>
      <Panel flush name={title}>
        <Table columns={presetColumns} empty={<Empty description="This game has no Git presets yet. Its worlds run legacy profiles that are not built here." title="No presets" />} label={title} loading={model.loading} rowKey={(row) => row.preset.id} rows={model.presets} />
      </Panel>
      <Panel flush name="Release pointers">
        <Table columns={pointerColumns} empty={<Empty description="Worlds appear here with their active and desired release." title="No worlds" />} label="Release pointers by world" loading={model.loading} rowKey={(row) => row.world.id} rows={model.pointers} />
      </Panel>
    </Page>
  );
}
