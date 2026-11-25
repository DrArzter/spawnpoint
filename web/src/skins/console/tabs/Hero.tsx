import type { WorldGlance } from "../../../core/models";
import { Address } from "../ui/Address";
import { useNow } from "../ui/Flashbar";
import { ProgressBar } from "../ui/ProgressBar";
import { Tick } from "../ui/Tick";
import { formatUptime } from "../../../lib/format";
import { t } from "../../../i18n";

/**
 * The live session in three facts: uptime, players and the address. A world
 * with no live session has no hero; its state is the header pill (R3).
 */
export function Hero({ glance, label }: Readonly<{ glance: WorldGlance; label: string }>) {
  const now = useNow(glance.launchedAt !== null);
  if (!glance.live) return null;
  return (
    <section aria-label={t("world.sessionGlance")} className="c-card c-hero">
      {glance.busy && <ProgressBar className="c-hero-busy" label={label} />}
      <dl className="c-hero-facts">
        <div className="c-hero-fact">
          <dt>{t("common.uptime")}</dt>
          <dd className="c-hero-big">{formatUptime(glance.launchedAt, now) ?? <span className="c-faint">—</span>}</dd>
        </div>
        <div className="c-hero-fact">
          <dt>{t("world.playersOnline")}</dt>
          <dd className="c-hero-big">{glance.players === null ? <span className="c-faint">—</span> : <Tick value={glance.players} />}</dd>
        </div>
        <div className="c-hero-fact c-hero-address">
          <dt>{t("common.address")}</dt>
          <dd>{glance.address ? <Address address={glance.address} copy /> : <span className="c-faint">—</span>}</dd>
        </div>
      </dl>
    </section>
  );
}
