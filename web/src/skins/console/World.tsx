import type { WorldModel } from "../../core/models";
import type { WorldTab } from "../../model";
import type { IconName } from "../../icons";
import { OperationProgress } from "./OperationProgress";
import { ActionButton } from "./ui/ActionButton";
import { Notices } from "./ui/Notice";
import { Overflow } from "./ui/Overflow";
import { PageHeader } from "./ui/PageHeader";
import { SplitPage } from "./ui/SplitPage";
import { Status } from "./ui/Status";
import { TabPanel, Tabs } from "./ui/Tabs";
import { BackupsTab } from "./tabs/Backups";
import { ConsoleTab } from "./tabs/Console";
import { CARD_ACTIONS, DetailsTab } from "./tabs/Details";
import { Hero } from "./tabs/Hero";
import { MetricsTab } from "./tabs/Metrics";
import { ReleasesTab } from "./tabs/Releases";
import { Siblings } from "./tabs/Siblings";
import { WhitelistTab } from "./tabs/Whitelist";
import { WipesTab } from "./tabs/Wipes";

const tabIcons: Readonly<Record<WorldTab, IconName>> = {
  details: "info",
  wipes: "layers",
  backups: "cloud_done",
  releases: "deployed_code",
  whitelist: "verified_user",
  console: "terminal",
  metrics: "monitoring",
};

/**
 * One world: the game's worlds in the list column (≥ 1024px), then the page.
 * The breadcrumb is the title and the pill the only state mark; the verbs sit
 * at the end edge, the hero holds the live session, the tabs the rest.
 */
export function World({ model }: Readonly<{ model: WorldModel }>) {
  const siblings = model.siblings ?? [];
  const more = model.more.filter((item) => !CARD_ACTIONS.includes(item.id));
  const page = (
    <div className="c-page">
      <PageHeader
        actions={(
          <>
            <ActionButton action={model.session} variant={model.session.id === "session.start" ? "primary" : "default"} />
            {model.invite && <ActionButton action={model.invite} />}
            <Overflow groups={[{ actions: more.filter((item) => !item.danger) }, { actions: more.filter((item) => item.danger) }]} label="More actions" />
          </>
        )}
        after={<Status status={model.sessionStatus} variant="pill" />}
        title={model.world.displayName}
        trail={[{ label: model.game.displayName, href: model.worldsHref, game: true }, { label: "Worlds", href: model.worldsHref }]}
      />
      <Notices notices={model.notices} />
      {model.progress && <OperationProgress model={model.progress} />}
      {model.glance && <Hero glance={model.glance} label={`${model.sessionStatus.label} ${model.world.displayName}`} />}
      <Tabs label="World" onChange={model.setTab} prefix="world" tabs={model.tabs.map((tab) => ({ ...tab, icon: tabIcons[tab.id] }))} value={model.tab} />
      <TabPanel id={model.tab} prefix="world">
        <Panel model={model} />
      </TabPanel>
    </div>
  );
  // The world is always the chosen item, so a narrow screen shows the page; the breadcrumb leads back to the list.
  return siblings.length > 0 ? <SplitPage list={<Siblings model={model} rows={siblings} />} selected>{page}</SplitPage> : page;
}

function Panel({ model }: Readonly<{ model: WorldModel }>) {
  switch (model.tab) {
    case "wipes": return <WipesTab model={model} />;
    case "backups": return <BackupsTab model={model.backups} />;
    case "releases": return <ReleasesTab model={model} />;
    case "whitelist": return model.whitelist ? <WhitelistTab model={model.whitelist} /> : <DetailsTab model={model} />;
    case "console": return model.console ? <ConsoleTab model={model.console} world={model.world.displayName} /> : <DetailsTab model={model} />;
    case "metrics": return model.metrics ? <MetricsTab model={model.metrics} worldId={model.world.id} /> : <DetailsTab model={model} />;
    default: return <DetailsTab model={model} />;
  }
}
