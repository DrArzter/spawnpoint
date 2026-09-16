import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { Column, DataTable } from "../components/ui/DataTable";
import { buildStatus, Status } from "../components/ui/Status";
import { Card, EmptyState, Ghost } from "../components/ui/Surfaces";
import { Icon } from "../icons";
import { commitUrl, repositoryName, shortCommit } from "../lib/format";
import type { Game, Preset, World } from "../model";
import { routeHash } from "../routing";
import type { Pending } from "../shell/actions";
import { releaseSummary } from "./WorldsScreen";

const SHOWN_RELEASES = 3;

export function ReleasesScreen({ game, granted, pending, loading, onCreateWorld }: {
  game: Game | undefined;
  granted: ReadonlySet<string>;
  pending: Pending | null;
  loading: boolean;
  onCreateWorld: (game: Game, preset: Preset) => void;
}) {
  const canManage = granted.has("world.manage");
  const presetColumns: Column<Preset>[] = [
    { id: "preset", label: "Preset", width: "28%", render: (preset) => <strong>{preset.displayName}</strong> },
    { id: "build", label: "Build", width: "16%", render: (preset) => { const status = buildStatus(preset.buildStatus); return <Status kind={status.kind} label={status.label} />; } },
    { id: "latest", label: "Latest release", width: "16%", render: (preset) => preset.latestRelease ? <code>{preset.latestRelease}</code> : <Ghost>None yet</Ghost> },
    // The newest few, then a count. A preset accumulates releases forever, and a
    // row that grows with them stops being a row.
    {
      id: "releases",
      label: "Releases",
      secondary: true,
      width: "24%",
      render: (preset) => {
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
    // The repository is the same for every preset here and was three times the
    // width of the thing worth reading; it rides in the title with the branch of
    // the URL, where it costs nothing.
    {
      id: "source",
      label: "Source",
      width: "14%",
      render: (preset) => (
        <a
          className="preset-source"
          href={commitUrl(preset.repository, preset.commit)}
          rel="noreferrer"
          target="_blank"
          title={`${repositoryName(preset.repository)} @ ${preset.commit}`}
        >
          <code>{shortCommit(preset.commit)}</code>
          <Icon name="open_in_new" size={14} />
        </a>
      ),
    },
    {
      id: "actions",
      label: "Actions",
      actions: true,
      render: (preset) => game ? (
        <Button
          disabled={!canManage || preset.buildStatus !== "ready" || pending?.kind === "create"}
          icon="add"
          onClick={() => onCreateWorld(game, preset)}
          size="small"
          title={!canManage ? "Your role cannot create worlds." : preset.buildStatus !== "ready" ? "This preset has no ready release yet." : "Create a world from this preset"}
          variant="text"
        >
          Create world
        </Button>
      ) : null,
    },
  ];
  const worldColumns: Column<World>[] = [
    { id: "world", label: "World", width: "28%", render: (world) => <a className="row-link" href={routeHash({ page: "worlds", accessTab: "users", gameId: game?.id ?? null, worldId: world.id })}>{world.displayName}</a> },
    { id: "preset", label: "Preset", width: "24%", render: (world) => game?.presets.find((preset) => preset.id === (world.preset?.id ?? world.profileId))?.displayName ?? world.profileId },
    { id: "active", label: "Active release", width: "140px", render: (world) => world.release.activeRelease ? <code>{world.release.activeRelease}</code> : <Ghost>None</Ghost> },
    { id: "desired", label: "Desired release", width: "140px", render: (world) => world.release.desiredRelease ? <code>{world.release.desiredRelease}</code> : <Ghost>None</Ghost> },
    { id: "pointer", label: "Pointer", render: (world) => <span>{releaseSummary(world)}</span> },
  ];

  return (
    <div className="page">
      <h1 className="visually-hidden">Releases</h1>
      <Card flush title={game ? `Presets of ${game.displayName}` : "Presets"}>
        <DataTable
          columns={presetColumns}
          empty={<EmptyState description="This game has no Git presets yet. Its worlds run legacy profiles that are not built here." icon="inventory" title="No presets" />}
          label={game ? `Presets of ${game.displayName}` : "Presets"}
          loading={loading}
          loadingRows={2}
          rowKey={(preset) => preset.id}
          rows={game?.presets ?? []}
        />
      </Card>
      <Card flush title="Release pointers">
        <DataTable
          columns={worldColumns}
          empty={<EmptyState description="Worlds appear here with their active and desired release." icon="public" title="No worlds" />}
          label="Release pointers by world"
          loading={loading}
          rowKey={(world) => world.id}
          rows={game?.worlds ?? []}
        />
      </Card>
    </div>
  );
}
