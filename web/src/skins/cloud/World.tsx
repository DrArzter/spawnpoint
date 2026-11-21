import { actionsOf } from "../../core/actions";
import type { WorldModel } from "../../core/models";
import type { WorldTab } from "../../model";
import type { IconName } from "../../icons";
import { cx } from "../../lib/cx";
import { ActionList } from "./Stub";
import { ActionButton } from "./ui/ActionButton";
import { Card } from "./ui/Card";
import { Notices } from "./ui/Notice";
import { Overflow } from "./ui/Overflow";
import { PageHeader } from "./ui/PageHeader";
import { Status } from "./ui/Status";
import { TabPanel, Tabs } from "./ui/Tabs";
import { BackupsTab } from "./tabs/Backups";
import { CARD_ACTIONS, DetailsTab } from "./tabs/Details";
import { Hero } from "./tabs/Hero";
import { ReleasesTab } from "./tabs/Releases";
import { Siblings } from "./tabs/Siblings";
import { WhitelistTab } from "./tabs/Whitelist";
import { WipesTab } from "./tabs/Wipes";

const tabIcons: Readonly<Record<WorldTab, IconName>> = {
  details: "info",
  wipes: "history",
  backups: "backup",
  releases: "inventory",
  whitelist: "verified",
  console: "terminal",
  metrics: "bar_chart",
};

/**
 * One world: the game's worlds in the list column (≥ 1024px), then the page.
 * The breadcrumb is the title and the pill the only state mark; the verbs sit
 * at the end edge, the hero holds the live session, the tabs the rest.
 */
export function World({ model }: Readonly<{ model: WorldModel }>) {
  const siblings = model.siblings ?? [];
  const more = model.more.filter((item) => !CARD_ACTIONS.includes(item.id));
  return (
    <div className={cx("c-world", siblings.length > 0 && "c-world-split")}>
      {siblings.length > 0 && <Siblings model={model} rows={siblings} />}
      <div className="c-page c-world-pane">
        <PageHeader
          actions={(
            <>
              <ActionButton action={model.session} variant={model.session.id === "session.start" ? "primary" : "default"} />
              {model.invite && <ActionButton action={model.invite} />}
              <Overflow groups={[{ actions: more.filter((item) => !item.danger) }, { actions: [model.refresh] }, { actions: more.filter((item) => item.danger) }]} label="More actions" />
            </>
          )}
          after={<Status status={model.sessionStatus} variant="pill" />}
          title={model.world.displayName}
          trail={[{ label: model.game.displayName, href: model.worldsHref, game: true }, { label: "Worlds", href: model.worldsHref }]}
        />
        <Notices notices={model.notices} />
        {model.glance && <Hero glance={model.glance} label={`${model.sessionStatus.label} ${model.world.displayName}`} />}
        <Tabs label="World" onChange={model.setTab} prefix="world" tabs={model.tabs.map((tab) => ({ ...tab, icon: tabIcons[tab.id] }))} value={model.tab} />
        <TabPanel id={model.tab} prefix="world">
          <Panel model={model} />
        </TabPanel>
      </div>
    </div>
  );
}

function Panel({ model }: Readonly<{ model: WorldModel }>) {
  switch (model.tab) {
    case "wipes": return <WipesTab model={model} />;
    case "backups": return <BackupsTab model={model.backups} />;
    case "releases": return <ReleasesTab model={model} />;
    case "whitelist": return model.whitelist ? <WhitelistTab model={model.whitelist} /> : <DetailsTab model={model} />;
    case "console":
    case "metrics": {
      // S5 stand-in: S5 draws the console and the metrics here.
      const tab = model.tab === "console" ? model.console : model.metrics;
      if (!tab) return <DetailsTab model={model} />;
      const noHost = model.metrics?.metrics.status === "ready" && model.metrics.metrics.value === null;
      return <Card label={model.tab}>{model.tab === "metrics" && noHost && <strong>No host right now</strong>}<ActionList actions={actionsOf(tab)} /></Card>;
    }
    default: return <DetailsTab model={model} />;
  }
}
