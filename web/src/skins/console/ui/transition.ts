import { MOTION, reducedMotion } from "./motion";

export type TransitionKind = "page" | "pane" | "tab";
export type TransitionDirection = "forward" | "back" | "none";

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => Promise<void>) => { finished?: Promise<void> } | undefined };

/** Whether this browser runs view transitions and the person did not ask for less motion. */
export function canTransition(): boolean {
  return typeof (document as ViewTransitionDocument).startViewTransition === "function" && !reducedMotion();
}

/**
 * The one way the console moves between views (A1–A3). `kind` names what
 * moves (the page area, a split page's pane, or a tab panel) and `direction`
 * which way. `update` makes the change and calls `arrived` once the new view
 * has rendered; the snapshot is held until then, or for the motion time at
 * most, so no blank frame shows. The choreography itself lives in base.css.
 */
export function runTransition(kind: TransitionKind, direction: TransitionDirection, update: (arrived: () => void) => void): void {
  const start = (document as ViewTransitionDocument).startViewTransition;
  if (!start || reducedMotion()) {
    update(() => undefined);
    return;
  }
  const root = document.documentElement;
  root.dataset.transition = kind;
  root.dataset.direction = direction;
  const clear = () => { delete root.dataset.transition; delete root.dataset.direction; };
  const transition = start.call(document, () => new Promise<void>((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    window.setTimeout(done, MOTION["--c-d3"]);
    update(done);
  }));
  if (transition?.finished) transition.finished.then(clear, clear);
  else clear();
}
