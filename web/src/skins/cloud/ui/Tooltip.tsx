import { useEffect, useRef, useState } from "react";

/*
 * One tooltip for the whole skin. A control names its tip with `data-tip`;
 * this layer shows it on hover and keyboard focus, above the anchor or below
 * it when the top bar is in the way, and ties it to the anchor with
 * aria-describedby while it shows.
 */

const TIP_ID = "c-tip";
const GAP = 8;

type Placed = Readonly<{ text: string; left: number; top: number }>;

export function TooltipLayer() {
  const [placed, setPlaced] = useState<Placed | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const show = (target: EventTarget | null) => {
      const element = target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
      if (!element || element === anchor.current) return;
      hide();
      const text = element.dataset.tip;
      if (!text) return;
      anchor.current = element;
      element.setAttribute("aria-describedby", TIP_ID);
      const rect = element.getBoundingClientRect();
      setPlaced({ text, left: rect.left + rect.width / 2, top: rect.top });
    };
    const hide = () => {
      anchor.current?.removeAttribute("aria-describedby");
      anchor.current = null;
      setPlaced(null);
    };
    const over = (event: Event) => show(event.target);
    const out = (event: Event) => {
      const next = (event as MouseEvent | FocusEvent).relatedTarget;
      if (anchor.current && next instanceof Node && anchor.current.contains(next)) return;
      if (anchor.current && event.target instanceof Node && anchor.current.contains(event.target)) hide();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    document.addEventListener("pointerover", over);
    document.addEventListener("focusin", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusout", out);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("focusin", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusout", out);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);

  // Clamped to the viewport; flipped below when it would cover the top bar.
  useEffect(() => {
    const element = tip.current;
    const target = anchor.current;
    if (!element || !target || !placed) return;
    const rect = target.getBoundingClientRect();
    const bar = document.querySelector(".c-topbar")?.getBoundingClientRect().bottom ?? 0;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const left = Math.max(GAP, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - GAP));
    let top = rect.top - height - GAP;
    if (top < GAP || (rect.top >= bar && top < bar + GAP)) top = rect.bottom + GAP;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }, [placed]);

  return <div className="c-tip" hidden={placed === null} id={TIP_ID} ref={tip} role="tooltip">{placed?.text}</div>;
}
