import { useEffect, useMemo, useState } from "react";

import { Icon, ProgressRing } from "../../../icons";
import { cx } from "../../../lib/cx";
import { clock, elapsedSeconds, eta, type Expectation } from "../../../lib/operation-time";
import { IconButton } from "./IconButton";
import { holdHeight, useLeaving } from "./leaving";
import { MOTION } from "./motion";
import { t } from "../../../i18n";

export type FlashKind = "busy" | "ok" | "err";

export type FlashItem = Readonly<{
  id: string;
  kind: FlashKind;
  message: string;
  /** A running operation's start; its elapsed time ticks beside the message. */
  since?: string;
  /** What that operation usually takes, for its ETA. */
  expectation?: Expectation;
  onDismiss?: () => void;
}>;

/** Seconds since `since` as m:ss, or null when not known. */
export function elapsed(since: string | undefined, now: number): string | null {
  const seconds = elapsedSeconds(since, now);
  return seconds === null ? null : clock(seconds);
}

/** The time now, read again once a clock tick while `live`. */
export function useNow(live = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), MOTION["--c-clock"]);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

/**
 * A running operation's time: how long it has run and, when the control plane
 * knows what it usually takes, the ETA or that it is taking longer. Everywhere
 * the console shows "running for" it shows this.
 */
export function RunningTime({ since, expectation, className }: Readonly<{ since: string; expectation?: Expectation; className?: string }>) {
  const now = useNow();
  const time = elapsed(since, now);
  const reading = expectation ? eta(since, expectation, now) : null;
  if (time === null) return <span className="c-mono">—</span>;
  return (
    <span className={cx("c-running", className)}>
      <span className="c-mono">{time}</span>
      {reading && <span className="c-mono c-eta" data-eta={reading.kind} data-tip={reading.tip}>{reading.text}</span>}
    </span>
  );
}

const icons = { ok: "check_circle", err: "error" } as const;

/**
 * Operations and outcomes at the end edge of the content, newest nearest the
 * edge. It floats, so it never pushes the page, and it takes no part in a
 * page switch (A1 rule).
 */
export function Flashbar({ items }: Readonly<{ items: readonly FlashItem[] }>) {
  const shown = useMemo(() => items.slice(-4), [items]);
  const stack = useLeaving(shown, (item) => item.id);
  return (
    <div aria-label={t("common.notifications")} aria-live="polite" className="c-flashbar" role="status">
      {stack.map(({ item, leaving }) => (
        <div inert={leaving || undefined} className={cx("c-flash", `c-flash-${item.kind}`, leaving && "c-leaving")} key={item.id} ref={leaving ? holdHeight : undefined}>
          {item.kind === "busy" ? <ProgressRing className="c-spin" size={20} /> : <Icon name={icons[item.kind]} size={20} />}
          <span className="c-flash-message">
            <span>{item.message}</span>
            {item.since && <RunningTime className="c-flash-time" expectation={item.expectation} since={item.since} />}
          </span>
          {item.onDismiss && <IconButton icon="close" label={t("common.dismiss")} onClick={item.onDismiss} tone="flash" />}
        </div>
      ))}
    </div>
  );
}
