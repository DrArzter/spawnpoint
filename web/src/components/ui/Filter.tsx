import { useRef, useState, type RefObject } from "react";

import type { IconName } from "../../icons";
import { cx } from "../../lib/cx";
import { Button } from "./Button";
import { SearchField } from "./Fields";
import { EmptyState } from "./Surfaces";

export type Filter<Row> = {
  query: string;
  setQuery: (query: string) => void;
  clear: () => void;
  active: boolean;
  rows: readonly Row[];
  total: number;
  field: RefObject<HTMLInputElement | null>;
};

// Every word typed must appear somewhere in the row's text, so a second word
// narrows the list and the order of the words does not matter.
export function matches(query: string, text: string): boolean {
  const haystack = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

// Search over a list already in hand. The caller says which fields are worth
// searching; nothing is fetched and nothing is asked of the server.
export function useFilter<Row>(rows: readonly Row[], text: (row: Row) => readonly (string | undefined)[]): Filter<Row> {
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement | null>(null);
  const active = query.trim().length > 0;
  return {
    query,
    setQuery,
    // Clearing can happen from a control that disappears with the query, so
    // the caret goes back to the box rather than to the top of the document.
    clear: () => { setQuery(""); field.current?.focus(); },
    active,
    rows: active ? rows.filter((row) => matches(query, text(row).join(" "))) : rows,
    total: rows.length,
    field,
  };
}

// The bar above a table: the search box, and once something is typed, how much
// of the list survived it. `plain` drops the bar's own padding and rule for
// content that is already spaced, such as a sheet.
export function FilterBar<Row>({ filter, label, placeholder, noun, disabled = false, plain = false, className }: {
  filter: Filter<Row>;
  label: string;
  placeholder?: string;
  noun: string;
  disabled?: boolean;
  plain?: boolean;
  className?: string;
}) {
  return (
    <div className={cx("filter-bar", plain && "filter-bar-plain", className)}>
      <SearchField
        autoComplete="off"
        className="filter-search"
        disabled={disabled}
        label={label}
        onChange={(event) => filter.setQuery(event.target.value)}
        placeholder={placeholder ?? label}
        ref={filter.field}
        value={filter.query}
      />
      <span aria-live="polite" className="filter-summary" role="status">
        {filter.active && `${filter.rows.length} of ${filter.total} ${noun}`}
      </span>
      {filter.active && <Button onClick={filter.clear} size="small" variant="text">Clear</Button>}
    </div>
  );
}

// What a list shows when the search, not the directory, emptied it.
export function NoMatches({ filter, icon, noun }: { filter: Pick<Filter<unknown>, "query" | "clear">; icon: IconName; noun: string }) {
  return (
    <EmptyState
      actions={<Button icon="close" onClick={filter.clear} variant="text">Clear search</Button>}
      description={<>Nothing matched <strong>{filter.query.trim()}</strong>.</>}
      icon={icon}
      title={`No ${noun} match your search`}
    />
  );
}
