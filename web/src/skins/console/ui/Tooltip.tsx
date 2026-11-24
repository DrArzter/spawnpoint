import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useLayer } from "../../../components/ui/layer";
import { type Align, type Side, positionPopover } from "../../../lib/placement";

/*
 * One tooltip for the whole skin. A control names its tip with `data-tip`;
 * this layer shows it on hover and keyboard focus, on the side the nearest
 * `data-tip-side` asks for (above by default; the page header asks for below),
 * aligned by `data-tip-align`, and ties it to the anchor with aria-describedby
 * while it shows. It is a popover, so a dialog cannot cover it.
 */

const TIP_ID = "c-tip";

type Placed = Readonly<{ text: string }>;

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
      setPlaced({ text });
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

  useLayer(tip, placed !== null);

  // The shared placement: a gap, a tail at the anchor's middle, flipped when its side does not fit.
  useLayoutEffect(() => {
    const element = tip.current;
    const target = anchor.current;
    if (!element || !target || !placed) return;
    const side = (target.closest<HTMLElement>("[data-tip-side]")?.dataset.tipSide ?? "top") as Side;
    const align = (target.closest<HTMLElement>("[data-tip-align]")?.dataset.tipAlign ?? "center") as Align;
    positionPopover(element, target, side, align);
  }, [placed]);

  return <div className="c-tip c-popover" data-layer="tip" id={TIP_ID} popover="manual" ref={tip} role="tooltip">{placed?.text}</div>;
}
