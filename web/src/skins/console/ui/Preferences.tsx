import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Icon } from "../../../icons";
import { cx } from "../../../lib/cx";
import { IconButton } from "./IconButton";
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

/** The table preferences gear: density and, for a paged table, the page size, as radio items. */
export function TablePreferences({ pageSize }: Readonly<{ pageSize?: Readonly<{ value: PageSize; set: (size: PageSize) => void }> }>) {
  const [density, setDensity] = useDensity();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const away = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !anchor.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const item = (checked: boolean, label: string, choose: () => void) => (
    <button aria-checked={checked} className="c-menu-item" key={label} onClick={() => { choose(); setOpen(false); anchor.current?.focus(); }} role="menuitemradio" type="button">
      <Icon name={checked ? "check" : "radio_button_unchecked"} size={20} />
      <span>{label}</span>
    </button>
  );
  return (
    <span className="c-prefs">
      <IconButton aria-controls={id} aria-expanded={open} aria-haspopup="menu" icon="settings" label={t("ui.preferences")} onClick={() => setOpen((value) => !value)} ref={anchor} />
      <div aria-label={t("ui.preferences")} className={cx("c-menu", "c-prefs-menu")} hidden={!open} id={id} onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); anchor.current?.focus(); } }} ref={menu} role="menu" /* NOSONAR focus moves to the items, which carry the tab stop */>
        <div aria-label={t("ui.density")} className="c-menu-group" role="group" /* NOSONAR a labelled group of menu items; <fieldset> is not valid inside a menu */>
          <div aria-hidden="true" className="c-menu-label">{t("ui.density")}</div>
          {item(density === "comfortable", t("ui.comfortable"), () => setDensity("comfortable"))}
          {item(density === "compact", t("ui.compact"), () => setDensity("compact"))}
        </div>
        {pageSize && (
          <div aria-label={t("ui.rowsPerPage")} className="c-menu-group c-menu-group-split" role="group" /* NOSONAR a labelled group of menu items; <fieldset> is not valid inside a menu */>
            <div aria-hidden="true" className="c-menu-label">{t("ui.rowsPerPage")}</div>
            {PAGE_SIZES.map((size) => item(pageSize.value === size, String(size), () => pageSize.set(size)))}
          </div>
        )}
      </div>
    </span>
  );
}
