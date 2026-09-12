import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { Column, DataTable } from "../components/ui/DataTable";
import { buildStatus, Status } from "../components/ui/Status";
import { Card, EmptyState, Ghost, PageHeader } from "../components/ui/Surfaces";
import { repositoryName, shortCommit } from "../lib/format";
import type { Game, Preset, World } from "../model";
import { routeHash } from "../routing";
import type { Pending } from "../shell/actions";
import { releaseSummary } from "./WorldsScreen";

export function ReleasesScreen({ game, granted, pending, loading, onCreateSave }: {
  game: Game | undefined;
  granted: ReadonlySet<string>;
  pending: Pending | null;
  loading: boolean;
  onCreateSave: (game: Game, preset: Preset) => void;
}) {
  const canManage = granted.has("world.manage");
  const presetColumns: Column<Preset>[] = [
    { id: "preset", label: "Preset", render: (preset) => <span><strong>{preset.displayName}</strong><small className="mono">{preset.id}</small></span> },
    { id: "build", label: "Build", width: "150px", render: (preset) => { const status = buildStatus(preset.buildStatus); return <Status kind={status.kind} label={status.label} />; } },
    { id: "latest", label: "Latest release", width: "140px", render: (preset) => preset.latestRelease ? <code>{preset.latestRelease}</code> : <Ghost>None yet</Ghost> },
    { id: "releases", label: "Releases", render: (preset) => preset.releases.length > 0 ? <span className="release-list">{[...preset.releases].reverse().map((release) => <Chip key={release} tone={release === preset.latestRelease ? "primary" : "tonal"}>{release}</Chip>)}</span> : <Ghost>No releases built</Ghost> },
    { id: "source", label: "Source", render: (preset) => <span className="preset-source"><a href={preset.repository} rel="noreferrer" target="_blank">{repositoryName(preset.repository)}</a><small className="mono">{shortCommit(preset.commit)}</small></span> },
    {
      id: "actions",
      label: "Actions",
      actions: true,
      render: (preset) => game ? (
        <Button
          disabled={!canManage || preset.buildStatus !== "ready" || pending?.kind === "create"}
          icon="add"
          onClick={() => onCreateSave(game, preset)}
          size="small"
          title={!canManage ? "Your role cannot create saves." : preset.buildStatus !== "ready" ? "This preset has no ready release yet." : "Create a save from this preset"}
          variant="text"
        >
          Create save
        </Button>
      ) : null,
    },
  ];
  const worldColumns: Column<World>[] = [
    { id: "world", label: "Save", render: (world) => <a className="row-link" href={routeHash({ page: "worlds", accessTab: "users", gameId: game?.id ?? null, worldId: world.id })}>{world.displayName}</a> },
    { id: "preset", label: "Preset", render: (world) => game?.presets.find((preset) => preset.id === (world.preset?.id ?? world.profileId))?.displayName ?? world.profileId },
    { id: "active", label: "Active release", width: "140px", render: (world) => world.release.activeRelease ? <code>{world.release.activeRelease}</code> : <Ghost>None</Ghost> },
    { id: "desired", label: "Desired release", width: "140px", render: (world) => world.release.desiredRelease ? <code>{world.release.desiredRelease}</code> : <Ghost>None</Ghost> },
    { id: "pointer", label: "Pointer", render: (world) => <span>{releaseSummary(world)}</span> },
  ];

  return (
    <div className="page">
      <PageHeader description={game ? `Presets are authored in Git and built into immutable releases. A save is created from a ready release of ${game.displayName}.` : undefined} title="Releases" />
      <Card flush title={game ? `Presets of ${game.displayName}` : "Presets"}>
        <DataTable
          columns={presetColumns}
          empty={<EmptyState description="This game has no Git presets yet. Its saves run legacy profiles that are not built here." icon="inventory" title="No presets" />}
          label={game ? `Presets of ${game.displayName}` : "Presets"}
          loading={loading}
          loadingRows={2}
          rowKey={(preset) => preset.id}
          rows={game?.presets ?? []}
        />
      </Card>
      <Card description="Which release each save runs and which one it is asked to run." flush title="Release pointers">
        <DataTable
          columns={worldColumns}
          empty={<EmptyState description="Saves appear here with their active and desired release." icon="public" title="No saves" />}
          label="Release pointers by save"
          loading={loading}
          rowKey={(world) => world.id}
          rows={game?.worlds ?? []}
        />
      </Card>
    </div>
  );
}
