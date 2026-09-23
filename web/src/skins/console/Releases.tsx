import { Chip } from "../../components/ui/Chip";
import { Column, DataTable } from "../../components/ui/DataTable";
import { Status } from "../../components/ui/Status";
import { Card, EmptyState, Ghost } from "../../components/ui/Surfaces";
import type { PointerRow, PresetRow, ReleasesModel } from "../../core/models";
import { Icon } from "../../icons";
import { commitUrl, repositoryName, shortCommit } from "../../lib/format";
import { ActionButton } from "./actions";

const SHOWN_RELEASES = 3;

export function Releases({ model }: Readonly<{ model: ReleasesModel }>) {
  const presetColumns: Column<PresetRow>[] = [
    { id: "preset", label: "Preset", width: "28%", render: (row) => <strong>{row.preset.displayName}</strong> },
    { id: "build", label: "Build", width: "16%", render: (row) => <Status kind={row.status.kind} label={row.status.label} /> },
    { id: "latest", label: "Latest build", width: "16%", render: (row) => (row.preset.latestRelease ? <code title="Immutable build ID, not the game version">{row.preset.latestRelease}</code> : <Ghost>None yet</Ghost>) },
    // The newest few, then a count. A preset accumulates releases forever, and a
    // row that grows with them stops being a row.
    {
      id: "releases",
      label: "Releases",
      secondary: true,
      width: "24%",
      render: ({ preset }) => {
        if (preset.releases.length === 0) return <Ghost>No releases built</Ghost>;
        const newest = [...preset.releases].reverse();
        const shown = newest.slice(0, SHOWN_RELEASES);
        const rest = newest.length - shown.length;
        return (
          <span className="release-list" title={newest.join(", ")}>
            {shown.map((release) => <Chip key={release} tone={release === preset.latestRelease ? "primary" : "tonal"}>{release}</Chip>)}
            {rest > 0 && <small className="secondary">+{rest}</small>}
          </span>
        );
      },
    },
    // Seven characters that differ per row, linking to the commit they name.
    {
      id: "source",
      label: "Source",
      width: "14%",
      render: ({ preset }) => (
        <a className="preset-source" href={commitUrl(preset.repository, preset.commit)} rel="noreferrer" target="_blank" title={`${repositoryName(preset.repository)} @ ${preset.commit}`}>
          <code>{shortCommit(preset.commit)}</code>
          <Icon name="open_in_new" size={14} />
        </a>
      ),
    },
    { id: "actions", label: "Actions", actions: true, render: (row) => (row.createWorld ? <ActionButton action={row.createWorld} size="small" variant="text" /> : null) },
  ];
  const worldColumns: Column<PointerRow>[] = [
    { id: "world", label: "World", width: "28%", render: (row) => <a className="row-link" href={row.href}>{row.world.displayName}</a> },
    { id: "preset", label: "Preset", width: "24%", render: (row) => row.presetName },
    { id: "active", label: "Running build", width: "140px", render: ({ world }) => (world.release.activeRelease ? <code title="Immutable build ID, not the game version">{world.release.activeRelease}</code> : <Ghost>Not started</Ghost>) },
    { id: "desired", label: "Next build", width: "140px", render: ({ world }) => (world.release.desiredRelease ? <code title="Immutable build ID, not the game version">{world.release.desiredRelease}</code> : <Ghost>None selected</Ghost>) },
    { id: "pointer", label: "Status", render: (row) => <span>{row.summary}</span> },
  ];
  const title = model.game ? `Presets of ${model.game.displayName}` : "Presets";
  return (
    <div className="page">
      <h1 className="visually-hidden">Releases</h1>
      <Card flush title={title}>
        <DataTable
          columns={presetColumns}
          empty={<EmptyState description="This game has no Git presets yet. Its worlds run legacy profiles that are not built here." icon="inventory" title="No presets" />}
          label={title}
          loading={model.loading}
          loadingRows={2}
          rowKey={(row) => row.preset.id}
          rows={model.presets}
        />
      </Card>
      <Card flush title="Release pointers">
        <DataTable
          columns={worldColumns}
          empty={<EmptyState description="Worlds appear here with their active and desired release." icon="public" title="No worlds" />}
          label="Release pointers by world"
          loading={model.loading}
          rowKey={(row) => row.world.id}
          rows={model.pointers}
        />
      </Card>
    </div>
  );
}
