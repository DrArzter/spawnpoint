import { useEffect, useState } from "react";

import { IconButton } from "./IconButton";

export const PAGE_SIZES = [10, 25, 50] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** The rows of one page, and how many pages there are. A page past the end falls back to the last. */
export function pageOf<Row>(rows: readonly Row[], page: number, size: number): Readonly<{ rows: readonly Row[]; page: number; pages: number }> {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((current - 1) * size, current * size), page: current, pages };
}

/** Paging state that returns to page 1 when the list it pages changes length. */
export function usePage(total: number): [number, (page: number) => void] {
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [total]);
  return [page, setPage];
}

// The page numbers to show: the ends, the current one and its neighbours.
function numbers(page: number, pages: number): (number | "gap")[] {
  const wanted = [...new Set([1, page - 1, page, page + 1, pages])].filter((item) => item >= 1 && item <= pages).sort((a, b) => a - b);
  return wanted.flatMap((item, index) => index > 0 && item - wanted[index - 1]! > 1 ? ["gap" as const, item] : [item]);
}

/** Previous, numbered pages and next; drawn only when there is more than one page. */
export function Pager({ page, pages, onPage, label = "Pages" }: Readonly<{ page: number; pages: number; onPage: (page: number) => void; label?: string }>) {
  if (pages <= 1) return null;
  return (
    <nav aria-label={label} className="c-pager">
      <IconButton className="c-icon-btn-sm" disabled={page === 1} icon="chevron_left" label="Previous page" onClick={() => onPage(page - 1)} />
      {numbers(page, pages).map((item, index) => item === "gap"
        ? <span aria-hidden="true" className="c-pager-gap" key={`gap-${index}`}>…</span>
        : <button aria-current={item === page ? "page" : undefined} aria-label={`Page ${item}`} className="c-pager-page" key={item} onClick={() => onPage(item)} type="button">{item}</button>)}
      <IconButton className="c-icon-btn-sm" disabled={page === pages} icon="chevron_right" label="Next page" onClick={() => onPage(page + 1)} />
    </nav>
  );
}
