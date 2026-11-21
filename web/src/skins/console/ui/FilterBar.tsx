import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Icon } from "../../../icons";
import { action } from "../../../core/actions";
import { ActionButton } from "./ActionButton";

/** A property a list can be narrowed by, with the values its rows hold and how many hold each. */
export type FilterProperty = Readonly<{ id: string; label: string; values: readonly Readonly<{ value: string; count: number }>[] }>;
/** `property` null is free text matched against the whole row. */
export type FilterToken = Readonly<{ property: string | null; value: string }>;

/** Rows that match every token: a property token by equality, a text token by a case-blind substring. */
export function applyFilter<Row>(rows: readonly Row[], tokens: readonly FilterToken[], read: (row: Row, property: string) => string, text: (row: Row) => string): Row[] {
  return rows.filter((row) => tokens.every((token) => token.property === null
    ? text(row).toLowerCase().includes(token.value.toLowerCase())
    : read(row, token.property) === token.value));
}

type Option = Readonly<{ key: string; label: string; count?: number; pick: () => void }>;

/**
 * The property filter: tokens such as "Hosting = Fleet" or "Text: pines"
 * and one combobox. The menu lists properties, then a property's values with
 * their counts; Enter on free text adds a text token; Backspace on an empty
 * input removes the last token. "N matches" shows only while filtering, Clear
 * only with two tokens or more (R3).
 */
export function FilterBar({ label, properties, tokens, onChange, matches, end, placeholder = "Filter" }: Readonly<{
  label: string;
  properties: readonly FilterProperty[];
  tokens: readonly FilterToken[];
  onChange: (tokens: readonly FilterToken[]) => void;
  matches?: number;
  /** Controls at the end of the bar: the preferences gear. */
  end?: ReactNode;
  placeholder?: string;
}>) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [property, setProperty] = useState<FilterProperty | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const add = (token: FilterToken) => {
    if (!tokens.some((item) => item.property === token.property && item.value === token.value)) onChange([...tokens, token]);
    setText("");
    setProperty(null);
    setActive(0);
    input.current?.focus();
  };
  const query = text.trim().toLowerCase();
  // Free text comes first, so Enter searches what was typed even when it also
  // matches a property's name ("re" in "Release").
  const textOption: Option[] = !property && query ? [{ key: "text", label: `Text: ${text.trim()}`, pick: () => add({ property: null, value: text.trim() }) }] : [];
  const options: Option[] = property
    ? property.values.filter((item) => item.value.toLowerCase().includes(query)).map((item) => ({ key: `${property.id}=${item.value}`, label: item.value, count: item.count, pick: () => add({ property: property.id, value: item.value }) }))
    : [...textOption, ...properties.filter((item) => item.label.toLowerCase().includes(query)).map((item) => ({ key: item.id, label: item.label, pick: () => { setProperty(item); setText(""); setActive(0); input.current?.focus(); } }))];
  const at = Math.min(active, Math.max(options.length - 1, 0));
  const labelOf = (id: string | null) => id === null ? "Text" : properties.find((item) => item.id === id)?.label ?? id;

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (options.length > 0) setActive((at + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && options[at]) options[at].pick();
      else if (query && !property) add({ property: null, value: text.trim() });
    } else if (event.key === "Escape") {
      if (property) setProperty(null);
      else setOpen(false);
    } else if (event.key === "Backspace" && text === "") {
      if (property) setProperty(null);
      else if (tokens.length > 0) onChange(tokens.slice(0, -1));
    }
  };

  const filtering = tokens.length > 0;
  return (
    <div className="c-filterbar">
      <div className="c-filter">
        <div className="c-filter-box">
          <Icon name="filter_list" size={20} />
          {tokens.map((token, index) => (
            <span className="c-filter-token" key={`${token.property}:${token.value}`}>
              <span><span className="c-filter-token-key">{labelOf(token.property)}{token.property === null ? ": " : " = "}</span>{token.value}</span>
              <button aria-label={`Remove ${labelOf(token.property)} ${token.value}`} onClick={() => onChange(tokens.filter((_, place) => place !== index))} type="button"><Icon name="close" size={16} /></button>
            </span>
          ))}
          {property && <span className="c-filter-token c-filter-token-draft">{property.label} =</span>}
          <input
            aria-activedescendant={open && options.length > 0 ? `${listId}-${at}` : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={open}
            aria-label={label}
            onBlur={() => setOpen(false)}
            onChange={(event) => { setText(event.target.value); setOpen(true); setActive(0); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
            placeholder={property ? `${property.label} value` : placeholder}
            ref={input}
            role="combobox"
            value={text}
          />
        </div>
        <div aria-label={property ? `${property.label} values` : "Filter by"} className="c-filter-menu" hidden={!open || options.length === 0} id={listId} role="listbox">
          <div aria-labelledby={`${listId}-label`} role="group">
            <div className="c-filter-menu-label" id={`${listId}-label`} role="presentation">{property ? property.label : "Filter by"}</div>
            {options.map((option, index) => (
              <div
                aria-selected={index === at}
                className="c-filter-option"
                id={`${listId}-${index}`}
                key={option.key}
                onMouseDown={(event) => { event.preventDefault(); option.pick(); }}
                onMouseMove={() => setActive(index)}
                role="option"
              >
                <span>{option.label}</span>
                {option.count !== undefined && <span className="c-filter-option-count">{option.count}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="c-filterbar-end">
        {filtering && matches !== undefined && <span className="c-filter-matches">{matches} {matches === 1 ? "match" : "matches"}</span>}
        {tokens.length >= 2 && <ActionButton action={action("filter.clear", "Clear", () => onChange([]))} size="sm" variant="ghost" />}
        {end}
      </div>
    </div>
  );
}
