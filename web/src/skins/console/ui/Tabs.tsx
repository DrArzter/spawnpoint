import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { MOTION, reducedMotion } from "./motion";

import { Icon, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";
import { Settle } from "./Settle";

export type TabItem<Id extends string> = Readonly<{ id: Id; label: string; count?: number; icon?: IconName }>;

/** The id of a tab's panel, so a page can name its TabPanel. */
export function tabPanelId(prefix: string, id: string): string {
  return `${prefix}-panel-${id}`;
}

function tabId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`;
}

/** The tab an arrow, Home or End key moves to from tab `at`; undefined for any other key. */
function tabForKey<Id extends string>(tabs: readonly TabItem<Id>[], at: number, key: string): TabItem<Id> | undefined {
  switch (key) {
    case "ArrowRight": return tabs[(at + 1) % tabs.length];
    case "ArrowLeft": return tabs[(at - 1 + tabs.length) % tabs.length];
    case "Home": return tabs[0];
    case "End": return tabs.at(-1);
    default: return undefined;
  }
}

/**
 * Tabs over one panel. The ink slides from the old tab to the new one (A3);
 * arrows, Home and End move between tabs; the active tab is kept in view and
 * the strip fades at its end edge while more tabs lie beyond it.
 */
export function Tabs<Id extends string>({ label, prefix, tabs, value, onChange, end }: Readonly<{
  label: string;
  /** Unique per page: ties each tab to its panel. */
  prefix: string;
  tabs: readonly TabItem<Id>[];
  value: Id;
  onChange: (id: Id) => void;
  /** Content at the end edge of the tab row. */
  end?: ReactNode;
}>) {
  const strip = useRef<HTMLDivElement>(null);
  const ink = useRef<HTMLSpanElement>(null);
  const [more, setMore] = useState(false);
  const select = useTabTransition(tabs, value, onChange);

  useLayoutEffect(() => {
    const row = strip.current;
    const active = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row || !active || !ink.current) return;
    ink.current.style.left = `${active.offsetLeft}px`;
    ink.current.style.width = `${active.offsetWidth}px`;
    if (active.offsetLeft < row.scrollLeft || active.offsetLeft + active.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = active.offsetLeft - 16;
    const place = () => {
      if (!ink.current) return;
      ink.current.style.left = `${active.offsetLeft}px`;
      ink.current.style.width = `${active.offsetWidth}px`;
    };
    const measure = () => setMore(row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    measure();
    // A font that loads late or a resize changes the tab widths; the ink follows.
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { place(); measure(); });
    resized?.observe(row);
    resized?.observe(active);
    row.addEventListener("scroll", measure);
    return () => { row.removeEventListener("scroll", measure); resized?.disconnect(); };
  }, [value, tabs]);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((tab) => tab.id === value);
    const target = tabForKey(tabs, at, event.key);
    if (!target) return;
    event.preventDefault();
    select(target.id);
    strip.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(prefix, target.id))}`)?.focus();
  };

  return (
    <div className="c-tabrow">
      <div aria-label={label} className={cx("c-tabs", more && "c-tabs-more")} data-scroll="expected" onKeyDown={onKey} ref={strip} role="tablist" /* NOSONAR roving tabindex: the selected tab carries the tab stop */>
        {tabs.map((tab) => {
          const selected = tab.id === value;
          return (
            <button
              aria-controls={tabPanelId(prefix, tab.id)}
              aria-selected={selected}
              className="c-tab"
              id={tabId(prefix, tab.id)}
              key={tab.id}
              onClick={() => select(tab.id)}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {tab.icon && <Icon name={tab.icon} size={19} />}
              <span>{tab.label}</span>
              {tab.count !== undefined && <span className="c-tab-count">{tab.count}</span>}
            </button>
          );
        })}
        <span aria-hidden="true" className="c-tab-ink" data-layer="glyph" ref={ink} />
      </div>
      {end && <div className="c-tabrow-end">{end}</div>}
    </div>
  );
}

type TabTransitionDocument = Document & { startViewTransition?: (update: () => Promise<void>) => { finished?: Promise<void> } };

/**
 * A2t: a tab switch runs as a view transition of the panel alone, moving
 * sideways by the tab bar's order. The update resolves once the new tab has
 * rendered, or after the motion time, so the old panel is never followed by a
 * blank frame.
 */
function useTabTransition<Id extends string>(tabs: readonly TabItem<Id>[], value: Id, onChange: (id: Id) => void): (id: Id) => void {
  const arrived = useRef<{ id: Id; resolve: () => void } | null>(null);
  useLayoutEffect(() => {
    if (arrived.current?.id === value) arrived.current.resolve();
  }, [value]);
  return (id: Id) => {
    const start = (document as TabTransitionDocument).startViewTransition;
    if (id === value || !start || reducedMotion()) {
      onChange(id);
      return;
    }
    const root = document.documentElement;
    const from = tabs.findIndex((tab) => tab.id === value);
    const to = tabs.findIndex((tab) => tab.id === id);
    root.dataset.transition = "tab";
    root.dataset.direction = to > from ? "forward" : "back";
    const clear = () => { delete root.dataset.transition; delete root.dataset.direction; };
    const transition = start.call(document, () => new Promise<void>((resolve) => {
      const done = () => { arrived.current = null; resolve(); };
      arrived.current = { id, resolve: done };
      window.setTimeout(done, MOTION["--c-d3"]);
      onChange(id);
    }));
    if (transition?.finished) transition.finished.then(clear, clear);
    else clear();
  };
}

/** The panel of the active tab. Its content fades in as one block when the tab changes (A3). */
export function TabPanel({ prefix, id, children }: Readonly<{ prefix: string; id: string; children: ReactNode }>) {
  return (
    <Settle>
      <div aria-labelledby={tabId(prefix, id)} className="c-tabpanel" id={tabPanelId(prefix, id)} key={id} role="tabpanel" tabIndex={0}>
        {children}
      </div>
    </Settle>
  );
}
