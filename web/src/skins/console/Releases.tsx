import type { PointerRow, PresetRow, ReleasesModel } from "../../core/models";
import { routeHash } from "../../routing";
import { ActionButton } from "./ui/ActionButton";
import { Card } from "./ui/Card";
import { Chip } from "./ui/Chip";
import { Empty } from "./ui/Empty";
import { Grid } from "./ui/Grid";
import { PageHeader } from "./ui/PageHeader";
import { Status } from "./ui/Status";
import { Table, type Column } from "./ui/Table";

/**
 * Releases (spec §6.4): the game's presets with their builds, and the
 * release each world points at. Stacked at every width.
 */
export function Releases({ model }: Readonly<{ model: ReleasesModel }>) {
  const game = model.game;
  const header = <PageHeader title="Releases" trail={game ? [{ label: game.displayName, href: routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: null, worldsView: "overview" }), game: true }] : []} />;
  if (!game) {
    return (
      <div className="c-page">
        {header}
        <Card label="Releases"><Empty icon="public" title="No games yet" /></Card>
      </div>
    );
  }
  const presets: Column<PresetRow>[] = [
    { id: "preset", header: "Preset", kind: "lead", render: (row) => row.preset.displayName },
    { id: "build", header: "Build", render: (row) => <Status status={row.status} /> },
    { id: "latest", header: "Latest release", render: (row) => row.preset.latestRelease ? <span className="c-mono">{row.preset.latestRelease}</span> : <span className="c-faint">—</span> },
    { id: "releases", header: "Releases", kind: "num", render: (row) => row.preset.releases.length },
    { id: "source", header: "Source", kind: "wide", render: (row) => <SourceRef row={row} /> },
    { id: "actions", header: "Actions", kind: "act", render: (row) => <>{row.build && <ActionButton action={row.build} size="sm" />}{row.createWorld && <ActionButton action={row.createWorld} size="sm" />}</> },
  ];
  const pointers: Column<PointerRow>[] = [
    { id: "world", header: "World", kind: "lead", className: "c-releases-world", render: (row) => <a href={row.href} title={row.world.displayName}>{row.world.displayName}</a> },
    { id: "preset", header: "Preset", className: "c-releases-preset", render: (row) => <span title={row.presetName}>{row.presetName}</span> },
    { id: "release", header: "Release", render: (row) => <PointerRelease row={row} /> },
    { id: "wipe", header: "Wipe", kind: "num", render: (row) => { const wipe = row.world.wipes.find((item) => item.state === "current"); return wipe ? `#${wipe.number}` : <span className="c-faint">—</span>; } },
  ];
  return (
    <div className="c-page">
      {header}
      <Grid kind="stack">
        <Card body="flush" count={model.loading ? undefined : model.presets.length} title="Presets">
          <Table columns={presets} empty={<Empty icon="inventory_2" size="sm" title="No presets" />} label="Presets" loading={model.loading} rowKey={(row) => row.preset.id} rows={model.presets} />
        </Card>
        <Card body="flush" count={model.loading ? undefined : model.pointers.length} title="Release pointers">
          <Table columns={pointers} empty={<Empty icon="public" size="sm" title="No worlds" />} label="Release pointers" loading={model.loading} rowKey={(row) => row.world.id} rows={model.pointers} />
        </Card>
      </Grid>
    </div>
  );
}

function SourceRef({ row }: Readonly<{ row: PresetRow }>) {
  const source = `${row.preset.repository.replace(/^https?:\/\/(www\.)?github\.com\//, "")}@${row.preset.commit.slice(0, 7)}`;
  return <span className="c-mono c-faint c-releases-source" title={`${row.preset.repository}@${row.preset.commit}`}>{source}</span>;
}

/** The release a world points at; the desired one only while it differs from the active one (R3). */
function PointerRelease({ row }: Readonly<{ row: PointerRow }>) {
  const { activeRelease, desiredRelease } = row.world.release;
  return (
    <span className="c-releases-release">
      <span className="c-mono">{row.summary}</span>
      {desiredRelease !== null && desiredRelease !== activeRelease && <Chip tip={`Desired ${desiredRelease}`}>→ {desiredRelease}</Chip>}
    </span>
  );
}
