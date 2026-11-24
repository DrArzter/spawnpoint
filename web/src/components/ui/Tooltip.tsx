import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cx } from "../../lib/cx";
import { type Align, type Side, positionPopover } from "../../lib/placement";
import { useLayer } from "./layer";

const OPEN_DELAY_MS = 120;

// The browser's own `title` waits about a second, never appears on a touch
// screen and cannot be reached from the keyboard. Anything a reader needs in
// order to understand a label gets this instead: hover, focus or tap.
// `side` and `align` place it through the shared placement; without `side`
// the nearest `data-tip-side` decides (a page head asks for below), else above.
export function Tooltip({ text, children, className, side, align = "center" }: Readonly<{ text: string; children: ReactNode; className?: string; side?: Side; align?: Align }>) {
  const [shown, setShown] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef(0);
  const id = useId();

  function place() {
    setShown(true);
  }

  function open() {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(place, OPEN_DELAY_MS);
  }

  function close() {
    window.clearTimeout(timer.current);
    setShown(false);
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // A popover in the top layer: a dialog or drawer the anchor sits in cannot cover it.
  useLayer(tip, shown);

  useLayoutEffect(() => {
    if (!shown || !tip.current || !anchor.current) return;
    const preferred = side ?? (anchor.current.closest<HTMLElement>("[data-tip-side]")?.dataset.tipSide as Side | undefined) ?? "top";
    positionPopover(tip.current, anchor.current, preferred, align);
  }, [shown, side, align]);

  useEffect(() => {
    if (!shown) return;
    const dismiss = () => setShown(false);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    // A tip is placed against the viewport, so anything that moves the page
    // leaves it behind. Closing is the honest answer to that.
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [shown]);

  return (
    <span // NOSONAR the tooltip anchor is focusable on purpose; its handlers only show and hide the tip
      aria-describedby={shown ? id : undefined}
      className={cx("tip-anchor", className)}
      onBlur={close}
      onClick={() => { if (shown) close(); else place(); }} // NOSONAR touch toggle; focus and hover already show the tip
      onFocus={open}
      onMouseEnter={open}
      onMouseLeave={close}
      ref={anchor}
      tabIndex={0} // NOSONAR keyboard users reach the tip through focus
    >
      {children}
      {shown && createPortal(
        <span className="tip popover" data-layer="tip" id={id} popover="manual" ref={tip} role="tooltip">
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}
