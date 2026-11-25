import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { action } from "../../core/actions";
import type { ShellModel } from "../../core/models";
import { tabTraverse, traverse } from "../../routing";
import { useSnackbarQueue, type SnackbarQueue } from "../../components/ui/Snackbar";
import { ScopeSwitcher } from "./Scope";
import { Dialog } from "./ui/Dialog";
import { AssistantPanel } from "./AssistantPanel";
import { Flashbar, type FlashItem } from "./ui/Flashbar";
import { BottomBar, Rail, TopBar } from "./ui/Frame";
import { MOTION } from "./ui/motion";
import { canTransition, runTransition } from "./ui/transition";
import { Palette } from "./ui/Palette";
import { ToastProvider } from "./ui/Toast";
import { TooltipLayer } from "./ui/Tooltip";
import { t } from "../../i18n";

/*
 * The console frame. The bars never move; the page area is the one element a
 * page switch traverses (A1), its header holds still and cross-fades (A1h),
 * and the flashbar and toasts float above it with names of their own so they
 * take no part in it.
 */

function segments(hash: string): string[] {
  return hash.replace(/^#\/?/, "").split("?")[0]!.split("/");
}

/**
 * Which page an address shows. A page is a section and its game; a world's
 * page is one page whichever world it shows, and Access is one page whichever
 * tab or item it shows. A world's tab is not a page of its own.
 */
export function pageKey(hash: string): string {
  const [section = "", game = "", world = ""] = segments(hash);
  if (section === "access" || section === "profile") return section;
  return `${section}/${game}${section === "worlds" && world ? "/world" : ""}`;
}

/** Which pane a split page shows: the world, or the Access tab and item. */
export function paneKey(hash: string): string {
  const [section = "", , world = ""] = segments(hash);
  if (section === "access") return segments(hash).slice(1).join("/");
  return section === "worlds" ? world : "";
}

/** A1 for another page, A2 for another pane of the same page, nothing for a tab. */
export function transitionKind(from: string, to: string): "page" | "pane" | null {
  if (pageKey(from) !== pageKey(to)) return "page";
  return paneKey(from) !== paneKey(to) ? "pane" : null;
}

const viewKey = (hash: string) => `${pageKey(hash)}|${paneKey(hash)}`;

/** Flashbar items: the game's running operations, then the outcomes the snackbar queue holds. */
export function flashItems(model: ShellModel, queue: SnackbarQueue, worldId: string | null): FlashItem[] {
  const operations: FlashItem[] = (model.flash?.operations ?? []).map((operation) => ({
    id: `op:${operation.id}`,
    kind: "busy",
    message: `${operation.label} · ${operation.worldName}`,
    // On the world's own page its hero shows the elapsed time (R3).
    ...(operation.worldId === worldId ? {} : { since: operation.startedAt, expectation: { expectedSeconds: operation.expectedSeconds, expectedSamples: operation.expectedSamples } }),
  }));
  const outcomes: FlashItem[] = queue.items.map((snack) => ({
    id: `snack:${snack.id}`,
    kind: snack.tone === "error" ? "err" : "ok",
    message: snack.message,
    onDismiss: () => queue.dismiss(snack.id),
  }));
  return [...operations, ...outcomes];
}

type Arrival = { target: string; resolve: () => void };

/** Moves to `href`; `arrived` runs when that view renders. */
function navigateUntilArrived(arrived: RefObject<Arrival | null>, href: string, done: () => void): void {
  arrived.current = { target: viewKey(href), resolve: () => { arrived.current = null; done(); } };
  window.location.hash = href.slice(1);
}

// A1: a link to another page swaps the page area inside a view transition that
// travels the way the hierarchy goes (data-direction, from `traverse`).
// A2: a link to another pane of a split page swaps only the pane (marked
// data-pane), so the list column stays still. The update resolves once the
// new view has rendered, so the old snapshot is never followed by a blank frame.
function usePageTransition(key: string) {
  const arrived = useRef<Arrival | null>(null);
  useLayoutEffect(() => {
    const waiting = arrived.current;
    if (waiting?.target === key) {
      arrived.current = null;
      waiting.resolve();
    }
  });
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href^='#/']") : null;
      if (!link || !canTransition() || link.target || link.hasAttribute("download") || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const href = link.getAttribute("href")!;
      const kind = transitionKind(window.location.hash, href);
      if (kind === null || (kind === "pane" && !document.querySelector("[data-pane]"))) return;
      event.preventDefault();
      const direction = kind === "page" ? traverse(window.location.hash, href) : tabTraverse(window.location.hash, href);
      runTransition(kind, direction, (done) => navigateUntilArrived(arrived, href, done));
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}

// A4 runs on the first view of a page in this session only; the h1 takes
// focus after a navigation, without a ring.
function useArrival(key: string, main: RefObject<HTMLElement | null>): boolean {
  const seen = useRef(new Set<string>());
  const [first, setFirst] = useState<string | null>(null);
  const initial = useRef(true);
  useLayoutEffect(() => {
    if (!seen.current.has(key)) {
      seen.current.add(key);
      setFirst(key);
    }
    if (initial.current) initial.current = false;
    else main.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
  }, [key, main]);
  return first === key;
}

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
}

const SHORTCUTS: readonly (readonly [string, string])[] = [
  [t("shell.ctrlK"), t("shell.searchRun")],
  [t("shell.gThenHW"), t("shell.homeWorldsReleasesAccess")],
  [t("shell.n19"), t("shell.chooseGame")],
  ["?", t("shell.keyboardShortcuts")],
  ["Esc", t("common.close")],
];

const SHORTCUT_PAGES: Readonly<Record<string, string>> = { w: "worlds", r: "releases", a: "access" };

/** Where "G then <letter>" goes; undefined for a letter that names no page. */
function shortcutHref(model: ShellModel, letter: string): string | undefined {
  if (letter === "h") return model.overview?.href;
  if (letter === "p") return "#/profile";
  return model.navigation.find((item) => item.id === SHORTCUT_PAGES[letter])?.href;
}

function useShortcuts(model: ShellModel, openPalette: () => void, openKeys: () => void) {
  const latest = useRef(model);
  latest.current = model;
  useEffect(() => {
    let leader = 0;
    const go = (letter: string) => {
      const current = latest.current;
      const href = shortcutHref(current, letter);
      if (href) window.location.hash = href.slice(1);
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPalette();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || document.querySelector("dialog[open], .c-palette")) return;
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
      const key = event.key.toLowerCase();
      if (leader && event.timeStamp - leader <= MOTION["--c-leader"]) {
        leader = 0;
        go(key);
        return;
      }
      leader = 0;
      if (key === "g") leader = event.timeStamp;
      else if (key === "/") { event.preventDefault(); openPalette(); }
      else if (key === "?") openKeys();
      else if (/^[1-9]$/.test(key)) {
        const game = latest.current.scope.games[Number(key) - 1];
        if (game) latest.current.scope.select(game.id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openPalette, openKeys]);
}

export function Shell({ model, children }: Readonly<{ model: ShellModel; children: ReactNode }>) {
  const [palette, setPalette] = useState(false);
  const [keys, setKeys] = useState(false);
  const main = useRef<HTMLElement>(null);
  const [hash, setHash] = useState(() => typeof window === "undefined" ? "" : window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const key = pageKey(hash);
  usePageTransition(viewKey(hash));
  const first = useArrival(key, main);
  const openPalette = useMemo(() => () => setPalette(true), []);
  const openKeys = useMemo(() => () => setKeys(true), []);
  useShortcuts(model, openPalette, openKeys);
  const queue = useSnackbarQueue();
  const parts = segments(hash);
  const worldId = parts[0] === "worlds" ? parts[2] ?? null : null;

  return (
    <ToastProvider>
      <div className="c-app">
        <TopBar model={model} onSearch={openPalette} scope={<ScopeSwitcher model={model.scope} />} />
        <div className="c-body">
          <Rail model={model} />
          <main className="c-main" data-first={first || undefined} id="main" ref={main}>{children}</main>
        </div>
        <BottomBar model={model} />
        <Flashbar items={flashItems(model, queue, worldId)} />
        {palette && <Palette model={model} onClose={() => setPalette(false)} />}
        {model.assistant?.shown && <AssistantPanel model={model.assistant} />}
        {keys && (
          <Dialog cancel={action("shortcuts.close", t("common.close"), () => setKeys(false))} title={t("shell.keyboardShortcuts")}>
            <dl className="c-keys">
              {SHORTCUTS.map(([combo, what]) => <div className="c-keys-row" key={combo}><dt>{what}</dt><dd><kbd>{combo}</kbd></dd></div>)}
            </dl>
          </Dialog>
        )}
        <TooltipLayer />
      </div>
    </ToastProvider>
  );
}
