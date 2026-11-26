import { useCallback, useEffect, useId, useRef, useState } from "react";

import { action } from "../../../core/actions";
import { IconButton } from "./IconButton";
import { Menu, type MenuGroup } from "./Menu";
import { PAGE_SIZES, type PageSize } from "./Pager";
import { t } from "../../../i18n";

export type Density = "comfortable" | "compact";

const DENSITY_KEY = "spawnpoint.console.density";
const PAGE_SIZE_KEY = "spawnpoint.console.page-size";

function read(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* Without storage the choice lasts this visit. */ }
}

/** Row density for every table and list of the skin, kept per browser and stamped on the document. */
export function useDensity(): [Density, (density: Density) => void] {
  const [density, setDensity] = useState<Density>(() => read(DENSITY_KEY) === "compact" ? "compact" : "comfortable");
  useEffect(() => {
    if (density === "compact") document.documentElement.dataset.density = "compact";
    else delete document.documentElement.dataset.density;
  }, [density]);
  const choose = useCallback((next: Density) => { write(DENSITY_KEY, next); setDensity(next); }, []);
  return [density, choose];
}

/** Rows per page for paged tables, kept per browser; 25 without a stored choice. */
export function usePageSize(): [PageSize, (size: PageSize) => void] {
  const [size, setSize] = useState<PageSize>(() => {
    const stored = Number(read(PAGE_SIZE_KEY));
    return (PAGE_SIZES as readonly number[]).includes(stored) ? (stored as PageSize) : 25;
  });
  const choose = useCallback((next: PageSize) => { write(PAGE_SIZE_KEY, String(next)); setSize(next); }, []);
  return [size, choose];
}

/** The table preferences gear: density and, for a paged table, the page size, as radio groups of the shared Menu. */
export function TablePreferences({ pageSize }: Readonly<{ pageSize?: Readonly<{ value: PageSize; set: (size: PageSize) => void }> }>) {
  const [density, setDensity] = useDensity();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const groups: MenuGroup[] = [{
    label: t("ui.density"),
    checked: `table.density.${density}`,
    actions: [
      action("table.density.comfortable", t("ui.comfortable"), () => setDensity("comfortable")),
      action("table.density.compact", t("ui.compact"), () => setDensity("compact")),
    ],
  }];
  if (pageSize) groups.push({
    label: t("ui.rowsPerPage"),
    checked: `table.page-size.${pageSize.value}`,
    actions: PAGE_SIZES.map((size) => action(`table.page-size.${size}`, String(size), () => pageSize.set(size))),
  });
  return (
    <span className="c-overflow">
      <IconButton aria-controls={id} aria-expanded={open} aria-haspopup="menu" icon="settings" label={t("ui.preferences")} onClick={() => setOpen((value) => !value)} ref={anchor} />
      <Menu anchor={anchor} groups={groups} id={id} label={t("ui.preferences")} onClose={close} open={open} />
    </span>
  );
}
