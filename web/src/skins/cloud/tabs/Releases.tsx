import type { Detail, ModsModel, WorldModel } from "../../../core/models";
import { formatBytes } from "../../../lib/format";
import { ActionButton } from "../ui/ActionButton";
import { Card } from "../ui/Card";
import { Chip } from "../ui/Chip";
import { Copy } from "../ui/Copy";
import { DetailList } from "../ui/DetailList";
import { Empty, LoadError } from "../ui/Empty";
import { Grid } from "../ui/Grid";
import { Table } from "../ui/Table";
import { TrackList, TrackTitle } from "../ui/TrackList";

const pointerStates = { unconfigured: "Unconfigured", unavailable: "Unavailable" } as const;

/** Active, the desired release only while it differs, and the pointer's state only when it is not usable. */
function releaseFacts(model: WorldModel): Detail[] {
  const { activeRelease, desiredRelease } = model.world.release;
  const facts: Detail[] = [{ label: "Active", value: activeRelease ? { type: "text", text: activeRelease, mono: true } : { type: "absent", text: "—" } }];
  if (desiredRelease && desiredRelease !== activeRelease) facts.push({ label: "Desired", value: { type: "text", text: desiredRelease, mono: true } });
  if (model.releases.state !== "available") facts.push({ label: "Pointer", value: { type: "status", status: { kind: "warning", label: pointerStates[model.releases.state] } } });
  return facts;
}

export function ReleasesTab({ model }: Readonly<{ model: WorldModel }>) {
  const rows = model.releases.rows;
  return (
    <Grid kind="stack">
      <Card body="kv" title="Release"><DetailList columns="fit" details={releaseFacts(model)} /></Card>
      {rows.some((row) => row.downloads.length > 0) && (
        <Card body="flush" title="Downloads">
          <TrackList
            label="Downloads"
            rowKey={(row) => row.name}
            rows={rows}
            tracks={[
              { id: "release", header: "Release", width: "minmax(0, 1fr)", kind: "stack", render: (row) => <TrackTitle line={row.status} title={<span className="c-mono">{row.name}</span>} /> },
              { id: "source", header: "Source", width: "120px", kind: "optional", render: (row) => row.sourceHref ? <a href={row.sourceHref} rel="noreferrer" target="_blank">Source</a> : <span className="c-faint">—</span> },
              { id: "download", header: "Download", width: "auto", compactWidth: "auto", kind: "end", quietHeader: true, render: (row) => <>{row.downloads.map((item) => <ActionButton action={item} key={item.id} size="sm" />)}</> },
            ]}
          />
        </Card>
      )}
      {model.releases.mods && <Mods mods={model.releases.mods} />}
    </Grid>
  );
}

function Mods({ mods }: Readonly<{ mods: ModsModel }>) {
  const files = mods.files;
  const head = (
    <>
      <Chip icon="dns" tip={`Release ${mods.release}`}>Server</Chip>
      {mods.split && <Chip icon="group" tip="Players install their own set">Split</Chip>}
    </>
  );
  return (
    <Card actions={head} body="flush" count={files.status === "ready" ? files.value.length : undefined} title="Mods">
      {files.status === "error"
        ? <LoadError error={files.error} kind={files.kind} retry={files.retry} size="sm" title="Mods could not be loaded" verb="read mods" />
        : (
          <Table
            columns={[
              { id: "mod", header: "Mod", kind: "lead", render: (row) => <strong title={row.file}>{row.file}</strong> },
              { id: "size", header: "Size", kind: "num", render: (row) => formatBytes(row.bytes) },
              { id: "sha", header: "SHA-256", kind: "wide", render: (row) => <span className="c-sum"><span className="c-mono" title={row.sha256}>{row.sha256.slice(0, 12)}</span><Copy value={row.sha256} what="SHA-256" /></span> },
              { id: "actions", header: "Actions", kind: "act", render: (row) => <ActionButton action={row.download} size="sm" /> },
            ]}
            empty={<Empty icon="inventory" size="sm" title="No mods" />}
            label="Mods"
            loading={files.status === "loading"}
            rowKey={(row) => row.sha256}
            rows={files.status === "ready" ? files.value : []}
          />
        )}
    </Card>
  );
}
