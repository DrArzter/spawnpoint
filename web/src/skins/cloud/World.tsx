import { actionsOf } from "../../core/actions";
import type { WorldModel } from "../../core/models";
import { wipeStatus } from "../../core/worlds";
import { ActionList } from "./Stub";
import { Card } from "./ui/Card";
import { DetailList } from "./ui/DetailList";
import { Grid } from "./ui/Grid";
import { Notices } from "./ui/Notice";
import { PageHeader } from "./ui/PageHeader";
import { Status } from "./ui/Status";
import { Table } from "./ui/Table";
import { TabPanel, Tabs } from "./ui/Tabs";

// S1/S2 stand-in; S4 and S5 build the world page and its tabs here.
export function World({ model }: Readonly<{ model: WorldModel }>) {
  const inventory = model.backups.inventory;
  const entries = inventory.status === "ready" ? inventory.value.entries : [];
  const more = entries.flatMap((entry) => [
    ...(model.backups.canRestore ? [model.backups.restore(entry)] : []),
    ...(model.backups.download ? [model.backups.download(entry)] : []),
  ]);
  const mods = model.releases.mods?.files;
  const list = model.whitelist?.list;
  return (
    <div className="c-page">
      <PageHeader after={<Status status={model.sessionStatus} variant="pill" />} title={model.world.displayName} trail={[{ label: model.game.displayName, href: model.worldsHref, game: true }, { label: "Worlds", href: model.worldsHref }]} />
      <Notices notices={model.notices} />
      <Tabs label="World sections" onChange={model.setTab} prefix="world" tabs={model.tabs} value={model.tab} />
      <TabPanel id={model.tab} prefix="world">
        {model.tab === "details" && (
          <Grid kind="detail">
            <Card body="kv" title="Session"><DetailList columns="two" details={model.sessionDetails} omit={["observed"]} /></Card>
            <Card body="kv" title="World"><DetailList columns="two" details={model.worldDetails} /></Card>
          </Grid>
        )}
        {model.tab === "wipes" && (
          <Card body="flush" count={model.wipes.length} title="Wipes">
            <Table
              columns={[
                { id: "wipe", header: "Wipe", kind: "lead", render: (row) => `#${row.wipe.number}` },
                { id: "state", header: "State", render: (row) => <Status status={wipeStatus(row.wipe)} /> },
                { id: "release", header: "Release", render: (row) => <span className="c-mono">{row.wipe.originRelease ?? "—"}</span> },
                { id: "actions", header: "Actions", kind: "act", render: (row) => <ActionList actions={[row.showBackups]} /> },
              ]}
              label="Wipes"
              rowKey={(row) => row.wipe.id}
              rows={model.wipes}
            />
          </Card>
        )}
        {model.tab === "releases" && mods?.status === "ready" && <Card title="Mods"><ul className="c-stub-names">{mods.value.map((mod) => <li key={mod.sha256}>{mod.file}</li>)}</ul></Card>}
        {model.tab === "whitelist" && model.whitelist && (
          <div className="c-stub-form">
            {list?.status === "ready" && !list.value.managed && <p className="c-line">Spawnpoint does not keep this world&apos;s whitelist yet; the first name replaces the server&apos;s list.</p>}
            {list?.status === "ready" && list.value.managed && list.value.rows.length === 0 && <strong>Nobody can join</strong>}
            <input aria-invalid={model.whitelist.draftError ? true : undefined} aria-label="Player name" onChange={(event) => model.whitelist?.setDraft(event.target.value)} value={model.whitelist.draft} />
            {model.whitelist.draftError && <span className="c-line">{model.whitelist.draftError}</span>}
          </div>
        )}
        {model.tab === "metrics" && model.metrics?.metrics.status === "ready" && model.metrics.metrics.value === null && <strong>No host right now</strong>}
        <Card label="Actions"><ActionList actions={[...actionsOf(model), ...more]} /></Card>
      </TabPanel>
    </div>
  );
}
