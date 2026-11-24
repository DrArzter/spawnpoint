// Where a popover (a menu or a tooltip) goes against the element it belongs
// to, and where its tail points. One rule for every popover in both skins:
// the caller chooses a side and an alignment; the popover keeps a gap from
// its anchor, flips to the other side when its own does not fit, stays on the
// screen, and its tail points at the middle of the anchor wherever it lands.

export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";

export type Box = Readonly<{ left: number; top: number; width: number; height: number }>;

export type PlacementRequest = Readonly<{
  anchor: Box;
  popover: Readonly<{ width: number; height: number }>;
  side: Side;
  align: Align;
  /** The space the screen offers: the viewport, less anything fixed over it, such as the top bar. */
  bounds: Box;
}>;

export type Placement = Readonly<{
  left: number;
  top: number;
  side: Side;
  /** Where the tail sits along the edge that faces the anchor, from that edge's start. */
  tail: number;
}>;

/** Between the anchor and the tip of the tail. */
export const POPOVER_GAP = 10;
/** Between a popover and the edge of the screen. */
export const POPOVER_MARGIN = 8;
/** The closest the tail comes to a corner, so it never leaves a rounded edge. */
const TAIL_INSET = 14;

const OPPOSITE: Readonly<Record<Side, Side>> = { top: "bottom", bottom: "top", left: "right", right: "left" };

const vertical = (side: Side) => side === "top" || side === "bottom";

/** Room on each side of the anchor, inside the bounds. */
function room(anchor: Box, bounds: Box): Readonly<Record<Side, number>> {
  return {
    top: anchor.top - bounds.top,
    bottom: bounds.top + bounds.height - (anchor.top + anchor.height),
    left: anchor.left - bounds.left,
    right: bounds.left + bounds.width - (anchor.left + anchor.width),
  };
}

function chooseSide(request: PlacementRequest): Side {
  const space = room(request.anchor, request.bounds);
  const need = (side: Side) => (vertical(side) ? request.popover.height : request.popover.width) + POPOVER_GAP + POPOVER_MARGIN;
  const preferred = request.side;
  if (space[preferred] >= need(preferred)) return preferred;
  const other = OPPOSITE[preferred];
  if (space[other] >= need(other)) return other;
  return space[other] > space[preferred] ? other : preferred;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

export function placePopover(request: PlacementRequest): Placement {
  const { anchor, popover, bounds, align } = request;
  const side = chooseSide(request);
  const along = vertical(side);
  const anchorStart = along ? anchor.left : anchor.top;
  const anchorSize = along ? anchor.width : anchor.height;
  const size = along ? popover.width : popover.height;
  const boundsStart = (along ? bounds.left : bounds.top) + POPOVER_MARGIN;
  const boundsEnd = (along ? bounds.left + bounds.width : bounds.top + bounds.height) - POPOVER_MARGIN - size;
  const wanted = align === "start" ? anchorStart : align === "end" ? anchorStart + anchorSize - size : anchorStart + anchorSize / 2 - size / 2;
  const cross = clamp(wanted, boundsStart, boundsEnd);
  const main = side === "top" ? anchor.top - POPOVER_GAP - popover.height
    : side === "bottom" ? anchor.top + anchor.height + POPOVER_GAP
      : side === "left" ? anchor.left - POPOVER_GAP - popover.width
        : anchor.left + anchor.width + POPOVER_GAP;
  const tail = clamp(anchorStart + anchorSize / 2 - cross, TAIL_INSET, size - TAIL_INSET);
  return along ? { left: cross, top: main, side, tail } : { left: main, top: cross, side, tail };
}

/** The viewport less the bars marked as covering the top of the screen (`data-covers-top`). */
export function screenBounds(): Box {
  const covers = [...document.querySelectorAll<HTMLElement>("[data-covers-top]")];
  const top = Math.max(0, ...covers.map((cover) => cover.getBoundingClientRect().bottom));
  return { left: 0, top, width: window.innerWidth, height: window.innerHeight - top };
}

/** Puts a popover element in place and tells its stylesheet the side and the tail. */
export function applyPlacement(element: HTMLElement, placement: Placement): void {
  element.style.left = `${Math.round(placement.left)}px`;
  element.style.top = `${Math.round(placement.top)}px`;
  element.dataset.side = placement.side;
  element.style.setProperty("--tail", `${Math.round(placement.tail)}px`);
}

/** Measures the popover and the anchor, places it, and returns where it went. */
export function positionPopover(element: HTMLElement, anchor: Element, side: Side, align: Align): Placement {
  const rect = anchor.getBoundingClientRect();
  const placement = placePopover({
    anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    popover: { width: element.offsetWidth, height: element.offsetHeight },
    side,
    align,
    bounds: screenBounds(),
  });
  applyPlacement(element, placement);
  return placement;
}
