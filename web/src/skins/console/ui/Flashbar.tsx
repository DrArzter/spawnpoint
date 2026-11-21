import { useEffect, useState } from "react";

import { Icon, ProgressRing } from "../../../icons";
import { cx } from "../../../lib/cx";
import { IconButton } from "./IconButton";
import { MOTION } from "./motion";

export type FlashKind = "busy" | "ok" | "err";

export type FlashItem = Readonly<{
  id: string;
  kind: FlashKind;
  message: string;
  /** A running operation's start; its elapsed time ticks beside the message. */
  since?: string;
  onDismiss?: () => void;
}>;

/** Seconds since `since` as m:ss, or null when not known. */
export function elapsed(since: string | undefined, now: number): string | null {
  const start = since ? Date.parse(since) : Number.NaN;
  if (Number.isNaN(start)) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
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

const icons = { ok: "check_circle", err: "error" } as const;

/**
 * Operations and outcomes at the end edge of the content, newest nearest the
 * edge. It floats, so it never pushes the page, and it takes no part in a
 * page switch (A1 rule).
 */
export function Flashbar({ items }: Readonly<{ items: readonly FlashItem[] }>) {
  const now = useNow(items.some((item) => item.since));
  return (
    <div aria-label="Notifications" aria-live="polite" className="c-flashbar" role="status">
      {items.slice(-4).map((item) => {
        const time = elapsed(item.since, now);
        return (
          <div className={cx("c-flash", `c-flash-${item.kind}`)} key={item.id}>
            {item.kind === "busy" ? <ProgressRing className="c-spin" size={20} /> : <Icon name={icons[item.kind]} size={20} />}
            <span className="c-flash-message">
              <span>{item.message}</span>
              {time && <span className="c-mono c-flash-time">{time}</span>}
            </span>
            {item.onDismiss && <IconButton icon="close" label="Dismiss" onClick={item.onDismiss} tone="flash" />}
          </div>
        );
      })}
    </div>
  );
}
