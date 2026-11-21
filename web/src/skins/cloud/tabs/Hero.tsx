import type { WorldGlance } from "../../../core/models";
import { Address } from "../ui/Address";
import { elapsed, useNow } from "../ui/Flashbar";
import { ProgressBar } from "../ui/ProgressBar";

/** How long a host has run: `h:mm:ss`, or `d h` past a day; null when the launch is unknown. */
export function uptime(since: string | null | undefined, now: number): string | null {
  const start = since ? Date.parse(since) : Number.NaN;
  if (Number.isNaN(start)) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  if (hours >= 24) return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** An operation's running time, ticking once a clock tick. */
export function Elapsed({ since }: Readonly<{ since: string }>) {
  const now = useNow();
  return <span className="c-mono">{elapsed(since, now) ?? "—"}</span>;
}

/**
 * The live session in three facts: uptime, players and the address. A world
 * with no live session has no hero; its state is the header pill (R3).
 */
export function Hero({ glance, label }: Readonly<{ glance: WorldGlance; label: string }>) {
  const now = useNow(glance.launchedAt !== null);
  if (!glance.live) return null;
  return (
    <section aria-label="Session at a glance" className="c-card c-hero">
      {glance.busy && <ProgressBar className="c-hero-busy" label={label} />}
      <dl className="c-hero-facts">
        <div className="c-hero-fact">
          <dt>Uptime</dt>
          <dd className="c-hero-big">{uptime(glance.launchedAt, now) ?? <span className="c-faint">—</span>}</dd>
        </div>
        <div className="c-hero-fact">
          <dt>Players online</dt>
          <dd className="c-hero-big">{glance.players ?? <span className="c-faint">—</span>}</dd>
        </div>
        <div className="c-hero-fact c-hero-address">
          <dt>Address</dt>
          <dd>{glance.address ? <Address address={glance.address} copy /> : <span className="c-faint">—</span>}</dd>
        </div>
      </dl>
    </section>
  );
}
