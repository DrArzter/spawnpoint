import type { WorldModel } from "../../core/models";
import { StubPage } from "./Stub";
import { Notices } from "./ui/Notice";
import { Status } from "./ui/Status";

// S1 stand-in; S4 and S5 build the world page and its tabs here.
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
    <StubPage after={<Status status={model.sessionStatus} variant="pill" />} model={model} more={more} title={model.world.displayName} trail={[{ label: "Worlds", href: model.worldsHref }]}>
      <Notices notices={model.notices} />
      {model.tab === "releases" && mods?.status === "ready" && <ul className="c-stub-names">{mods.value.map((mod) => <li key={mod.sha256}>{mod.file}</li>)}</ul>}
      {model.tab === "whitelist" && model.whitelist && (
        <div className="c-stub-form">
          {list?.status === "ready" && !list.value.managed && <p className="c-line">Spawnpoint does not keep this world&apos;s whitelist yet; the first name replaces the server&apos;s list.</p>}
          {list?.status === "ready" && list.value.managed && list.value.rows.length === 0 && <strong>Nobody can join</strong>}
          <input aria-invalid={model.whitelist.draftError ? true : undefined} aria-label="Player name" onChange={(event) => model.whitelist?.setDraft(event.target.value)} value={model.whitelist.draft} />
          {model.whitelist.draftError && <span className="c-line">{model.whitelist.draftError}</span>}
        </div>
      )}
      {model.tab === "metrics" && model.metrics?.metrics.status === "ready" && model.metrics.metrics.value === null && <strong>No host right now</strong>}
    </StubPage>
  );
}
