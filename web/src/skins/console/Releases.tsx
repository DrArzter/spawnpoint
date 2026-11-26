import type { PointerRow, PresetRow, ReleasesModel } from "../../core/models";
import { routeHash } from "../../routing";
import { BuildState } from "./BuildState";
import { ActionButton } from "./ui/ActionButton";
import { Card } from "./ui/Card";
import { Chip } from "./ui/Chip";
import { Empty } from "./ui/Empty";
import { Grid } from "./ui/Grid";
import { PageHeader } from "./ui/PageHeader";
import { SourceRef } from "./ui/SourceRef";
import { Table, type Column } from "./ui/Table";
import { t } from "../../i18n";

/**
 * Releases (spec §6.4): the game's presets with their builds, and the
 * release each world points at. Stacked at every width.
 */
export function Releases({ model }: Readonly<{ model: ReleasesModel }>) {
  const game = model.game;
  const header = <PageHeader title={t("common.releases")} trail={game ? [{ label: game.displayName, href: routeHash({ page: "worlds", accessTab: "users", gameId: game.id, worldId: null, worldsView: "overview" }), game: true }] : []} />;
  if (!game) {
    return (
      <div className="c-page">
        {header}
        <Card label={t("common.releases")}><Empty icon="public" title={t("common.noGamesYet")} /></Card>
      </div>
    );
  }
  const presets: Column<PresetRow>[] = [
    { id: "preset", header: t("common.preset"), kind: "lead", render: (row) => row.preset.displayName },
    { id: "build", header: t("common.build"), render: (row) => <BuildState row={row} /> },
    { id: "latest", header: t("common.latestRelease"), render: (row) => row.preset.latestRelease ? <span className="c-mono">{row.preset.latestRelease}</span> : <span className="c-faint">—</span> },
    { id: "releases", header: t("common.releases"), kind: "wide", className: "c-col-num", render: (row) => row.preset.releases.length },
    { id: "source", header: t("common.source"), kind: "wide", clip: true, render: (row) => <SourceRef commit={row.preset.commit} repository={row.preset.repository} /> },
    { id: "actions", header: t("common.actions"), kind: "act", render: (row) => <>{row.build && <ActionButton action={row.build} size="sm" />}{row.createWorld && <ActionButton action={row.createWorld} size="sm" />}</> },
  ];
  const pointers: Column<PointerRow>[] = [
    { id: "world", header: t("common.world"), kind: "lead", className: "c-releases-world", render: (row) => <a href={row.href} title={row.world.displayName}>{row.world.displayName}</a> },
    { id: "preset", header: t("common.preset"), clip: true, render: (row) => <span title={row.presetName}>{row.presetName}</span> },
    { id: "release", header: t("common.release"), render: (row) => <PointerRelease row={row} /> },
    { id: "wipe", header: t("common.wipe"), kind: "num", render: (row) => { const wipe = row.world.wipes.find((item) => item.state === "current"); return wipe ? `#${wipe.number}` : <span className="c-faint">—</span>; } },
  ];
  return (
    <div className="c-page">
      {header}
      <Grid kind="stack">
        <Card body="flush" count={model.loading ? undefined : model.presets.length} title={t("releases.presets")}>
          <Table columns={presets} empty={<Empty icon="inventory_2" size="sm" title={t("releases.noPresets")} />} label={t("releases.presets")} loading={model.loading} rowKey={(row) => row.preset.id} rows={model.presets} />
        </Card>
        <Card body="flush" count={model.loading ? undefined : model.pointers.length} title={t("releases.releasePointers")}>
          <Table columns={pointers} empty={<Empty icon="public" size="sm" title={t("common.noWorlds")} />} label={t("releases.releasePointers")} loading={model.loading} rowKey={(row) => row.world.id} rows={model.pointers} />
        </Card>
      </Grid>
    </div>
  );
}

/** The release a world points at; the desired one only while it differs from the active one (R3). */
function PointerRelease({ row }: Readonly<{ row: PointerRow }>) {
  const { activeRelease, desiredRelease } = row.world.release;
  return (
    <span className="c-releases-release">
      <span className="c-mono">{activeRelease ?? row.summary}</span>
      {desiredRelease !== null && desiredRelease !== activeRelease && <Chip tip={t("common.desiredDesiredRelease", { desiredRelease })}>→ {desiredRelease}</Chip>}
    </span>
  );
}
