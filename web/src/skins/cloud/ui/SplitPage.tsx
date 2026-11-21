import type { ReactNode } from "react";

/**
 * A list column beside a pane: the world page and Access. The page runs to
 * the edges of the main area (no gutter of its own), the list column stays
 * put while the pane changes (A2 marks the pane), and under 1024px one of the
 * two shows: the pane while an item is selected, else the list.
 */
export function SplitPage({ list, selected, children }: Readonly<{ list: ReactNode; /** An item is chosen, so a narrow screen shows the pane. */ selected: boolean; children: ReactNode }>) {
  return (
    <div className="c-split" data-selected={selected || undefined}>
      <div className="c-split-list">{list}</div>
      <div className="c-split-pane" data-pane="">{children}</div>
    </div>
  );
}
