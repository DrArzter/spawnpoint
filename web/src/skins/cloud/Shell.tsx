import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { action } from "../../core/actions";
import type { ShellModel } from "../../core/models";
import { useSnackbarQueue, type SnackbarQueue } from "../../components/ui/Snackbar";
import { ScopeSwitcher } from "./Scope";
import { Dialog } from "./ui/Dialog";
import { Flashbar, type FlashItem } from "./ui/Flashbar";
import { BottomBar, Rail, TopBar } from "./ui/Frame";
import { MOTION, reducedMotion } from "./ui/motion";
import { Palette } from "./ui/Palette";
import { ToastProvider } from "./ui/Toast";
import { TooltipLayer } from "./ui/Tooltip";

/*
 * The cloud frame. The bars never move; the page area is the one element a
 * page switch slides (A1), and the flashbar and toasts float above it with
 * names of their own so they take no part in it.
 */

function segments(hash: string): string[] {
  return hash.replace(/^#\/?/, "").split("?")[0]!.split("/");
}

/** Which page an address shows: a world's tab is not a page of its own. */
export function pageKey(hash: string): string {
  return segments(hash).slice(0, 3).join("/");
}

/** Flashbar items: the game's running operations, then the outcomes the snackbar queue holds. */
export function flashItems(model: ShellModel, queue: SnackbarQueue, worldId: string | null): FlashItem[] {
  const operations: FlashItem[] = (model.flash?.operations ?? []).map((operation) => ({
    id: `op:${operation.id}`,
    kind: "busy",
    message: `${operation.label} · ${operation.worldName}`,
    // On the world's own page its hero shows the elapsed time (R3).
    ...(operation.worldId === worldId ? {} : { since: operation.startedAt }),
  }));
  const outcomes: FlashItem[] = queue.items.map((snack) => ({
    id: `snack:${snack.id}`,
    kind: snack.tone === "error" ? "err" : "ok",
    message: snack.message,
    onDismiss: () => queue.dismiss(snack.id),
  }));
  return [...operations, ...outcomes];
}

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => Promise<void>) => unknown };

// A1: a link to another page swaps the page area inside a view transition.
// The update resolves once the new page has rendered, so the old snapshot is
// never followed by a blank frame.
function usePageTransition(key: string) {
  const arrived = useRef<{ target: string; resolve: () => void } | null>(null);
  useLayoutEffect(() => {
    const waiting = arrived.current;
    if (waiting && waiting.target === key) {
      arrived.current = null;
      waiting.resolve();
    }
  });
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href^='#/']") : null;
      const start = (document as ViewTransitionDocument).startViewTransition;
      if (!link || !start || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || reducedMotion()) return;
      const href = link.getAttribute("href")!;
      const target = pageKey(href);
      if (target === pageKey(window.location.hash)) return;
      event.preventDefault();
      start.call(document, () => new Promise<void>((resolve) => {
        const done = () => { arrived.current = null; resolve(); };
        arrived.current = { target, resolve: done };
        window.setTimeout(done, MOTION["--c-d3"]);
        window.location.hash = href.slice(1);
      }));
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
  ["Ctrl K or /", "Search and run"],
  ["G then H, W, R, A, P", "Home, Worlds, Releases, Access, Profile"],
  ["1 to 9", "Choose a game"],
  ["?", "Keyboard shortcuts"],
  ["Esc", "Close"],
];

function useShortcuts(model: ShellModel, openPalette: () => void, openKeys: () => void) {
  const latest = useRef(model);
  latest.current = model;
  useEffect(() => {
    let leader = false;
    const go = (letter: string) => {
      const current = latest.current;
      const href = letter === "h" ? current.overview?.href
        : letter === "p" ? "#/profile"
        : current.navigation.find((item) => item.id === ({ w: "worlds", r: "releases", a: "access" } as Record<string, string>)[letter])?.href;
      if (href) window.location.hash = href.slice(1);
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPalette();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || document.querySelector("dialog[open], .c-palette")) return;
      const key = event.key.toLowerCase();
      if (leader) {
        leader = false;
        go(key);
        return;
      }
      if (key === "g") leader = true;
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
  usePageTransition(key);
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
        {keys && (
          <Dialog cancel={action("shortcuts.close", "Close", () => setKeys(false))} title="Keyboard shortcuts">
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
