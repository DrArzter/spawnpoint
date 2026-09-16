import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cx } from "../../lib/cx";

const OPEN_DELAY_MS = 120;
const HALF_WIDTH = 132;

type Placement = { left: number; top: number; below: boolean };

// The browser's own `title` waits about a second, never appears on a touch
// screen and cannot be reached from the keyboard. Anything a reader needs in
// order to understand a label gets this instead: hover, focus or tap.
export function Tooltip({ text, children, className }: Readonly<{ text: string; children: ReactNode; className?: string }>) {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef(0);
  const id = useId();

  function place() {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const below = rect.top < 72;
    setPlacement({
      // Clamped so a tip at the edge of the screen stays on it.
      left: Math.min(Math.max(rect.left + rect.width / 2, HALF_WIDTH + 8), window.innerWidth - HALF_WIDTH - 8),
      top: below ? rect.bottom : rect.top,
      below,
    });
  }

  function open() {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(place, OPEN_DELAY_MS);
  }

  function close() {
    window.clearTimeout(timer.current);
    setPlacement(null);
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (placement === null) return;
    const dismiss = () => setPlacement(null);
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
  }, [placement]);

  return (
    <span
      aria-describedby={placement ? id : undefined}
      className={cx("tip-anchor", className)}
      onBlur={close}
      onClick={() => { if (placement) close(); else place(); }}
      onFocus={open}
      onMouseEnter={open}
      onMouseLeave={close}
      ref={anchor}
      tabIndex={0}
    >
      {children}
      {placement && createPortal(
        <span className={cx("tip", placement.below && "tip-below")} id={id} role="tooltip" style={{ left: placement.left, top: placement.top }}>
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}
