import { useEffect, useRef, type ReactNode } from "react";

import { MOTION, reducedMotion } from "./motion";

/**
 * Lets the height of what it holds glide instead of snap. A tab's content
 * grows or shrinks when its data arrives or another world's replaces it; the
 * box eases from the old height to the new one while the content is already at
 * its final size, so nothing below it jumps and nothing is shown twice. It
 * clips only while it moves. Under reduced motion the height just changes.
 */
export function Settle({ children }: Readonly<{ children: ReactNode }>) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outer = box.current;
    const inner = content.current;
    if (!outer || !inner || typeof ResizeObserver === "undefined") return;
    let settled = inner.getBoundingClientRect().height;
    let timer = 0;
    const done = () => {
      window.clearTimeout(timer);
      delete outer.dataset.settling;
      outer.style.height = "";
    };
    const observer = new ResizeObserver(() => {
      const next = inner.getBoundingClientRect().height;
      if (next === settled) return;
      const from = outer.dataset.settling === undefined ? settled : outer.getBoundingClientRect().height;
      settled = next;
      if (reducedMotion()) return;
      // Start where the old content ended, commit that, then move to the new height.
      delete outer.dataset.settling;
      outer.style.height = `${from}px`;
      void outer.offsetHeight;
      outer.dataset.settling = "";
      outer.style.height = `${next}px`;
      window.clearTimeout(timer);
      timer = window.setTimeout(done, MOTION["--c-d3"] + 80);
    });
    const onEnd = (event: TransitionEvent) => { if (event.target === outer && event.propertyName === "height") done(); };
    outer.addEventListener("transitionend", onEnd);
    observer.observe(inner);
    return () => {
      observer.disconnect();
      outer.removeEventListener("transitionend", onEnd);
      done();
    };
  }, []);
  return (
    <div className="c-settle" ref={box}>
      <div ref={content}>{children}</div>
    </div>
  );
}
