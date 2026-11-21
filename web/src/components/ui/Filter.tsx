import { useRef, useState, type RefObject } from "react";

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
