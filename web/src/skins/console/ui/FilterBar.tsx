import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Icon } from "../../../icons";
import { action } from "../../../core/actions";
import { ActionButton } from "./ActionButton";
import { t } from "../../../i18n";

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

type Pick = Readonly<{ add: (token: FilterToken) => void; choose: (property: FilterProperty) => void }>;

/**
 * What the menu offers: a chosen property's values, or free text first (so
 * Enter searches what was typed even when it also matches a property's name,
 * "re" in "Release") and then the properties.
 */
function filterOptions(properties: readonly FilterProperty[], property: FilterProperty | null, text: string, pick: Pick): Option[] {
  const query = text.trim().toLowerCase();
  if (property) {
    return property.values
      .filter((item) => item.value.toLowerCase().includes(query))
      .map((item) => ({ key: `${property.id}=${item.value}`, label: item.value, count: item.count, pick: () => pick.add({ property: property.id, value: item.value }) }));
  }
  const free: Option[] = query ? [{ key: "text", label: t("ui.textTrim", { trim: text.trim() }), pick: () => pick.add({ property: null, value: text.trim() }) }] : [];
  const named = properties.filter((item) => item.label.toLowerCase().includes(query)).map((item) => ({ key: item.id, label: item.label, pick: () => pick.choose(item) }));
  return [...free, ...named];
}

type KeyCommand = "down" | "up" | "pick" | "add-text" | "swallow" | "leave-property" | "close" | "drop-token" | "none";

/** What a key does to the combobox, as data; the component applies it. */
function keyCommand(key: string, now: Readonly<{ open: boolean; picks: boolean; typed: boolean; property: boolean; empty: boolean; tokens: number }>): KeyCommand {
  switch (key) {
    case "ArrowDown": return "down";
    case "ArrowUp": return "up";
    case "Enter":
      if (now.open && now.picks) return "pick";
      return now.typed && !now.property ? "add-text" : "swallow";
    case "Escape": return now.property ? "leave-property" : "close";
    case "Backspace":
      if (!now.empty) return "none";
      if (now.property) return "leave-property";
      return now.tokens > 0 ? "drop-token" : "none";
    default: return "none";
  }
}

/**
 * The property filter: tokens such as "Hosting = Fleet" or "Text: pines"
 * and one combobox. The menu lists properties, then a property's values with
 * their counts; Enter on free text adds a text token; Backspace on an empty
 * input removes the last token. "N matches" shows only while filtering, Clear
 * only with two tokens or more (R3).
 */
export function FilterBar({ label, properties, tokens, onChange, matches, end, placeholder = t("ui.filter"), disabled = false }: Readonly<{
  label: string;
  properties: readonly FilterProperty[];
  tokens: readonly FilterToken[];
  onChange: (tokens: readonly FilterToken[]) => void;
  matches?: number;
  /** Controls at the end of the bar: the preferences gear. */
  end?: ReactNode;
  placeholder?: string;
  /** While the rows it narrows are still loading. */
  disabled?: boolean;
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
  const choose = (item: FilterProperty) => { setProperty(item); setText(""); setActive(0); input.current?.focus(); };
  const options = filterOptions(properties, property, text, { add, choose });
  const at = Math.min(active, Math.max(options.length - 1, 0));
  const labelOf = (id: string | null) => id === null ? t("ui.text") : properties.find((item) => item.id === id)?.label ?? id;

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const command = keyCommand(event.key, { open, picks: options[at] !== undefined, typed: query !== "", property: property !== null, empty: text === "", tokens: tokens.length });
    switch (command) {
      case "down":
      case "up":
        event.preventDefault();
        setOpen(true);
        if (options.length > 0) setActive((at + (command === "down" ? 1 : options.length - 1)) % options.length);
        break;
      case "pick":
        event.preventDefault();
        options[at].pick();
        break;
      case "add-text":
        event.preventDefault();
        add({ property: null, value: text.trim() });
        break;
      case "swallow":
        event.preventDefault();
        break;
      case "leave-property":
        setProperty(null);
        break;
      case "close":
        setOpen(false);
        break;
      case "drop-token":
        onChange(tokens.slice(0, -1));
        break;
    }
  };

  const filtering = tokens.length > 0;
  const showMatches = filtering && matches !== undefined;
  const clearable = tokens.length >= 2;
  return (
    <div className="c-filterbar">
      <div className="c-filter">
        <div className="c-filter-box">
          <Icon name="filter_list" size={20} />
          {tokens.map((token, index) => (
            <span className="c-filter-token" key={`${token.property}:${token.value}`}>
              <span><span className="c-filter-token-key">{labelOf(token.property)}{token.property === null ? ": " : " = "}</span>{token.value}</span>
              <button aria-label={t("ui.removeLabelOfTokenValue", { labelOf: labelOf(token.property), tokenValue: token.value })} onClick={() => onChange(tokens.filter((_, place) => place !== index))} type="button"><Icon name="close" size={16} /></button>
            </span>
          ))}
          {property && <span className="c-filter-token c-filter-token-draft">{property.label} =</span>}
          <input
            aria-activedescendant={open && options.length > 0 ? `${listId}-${at}` : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={open}
            aria-label={label}
            disabled={disabled}
            onBlur={() => setOpen(false)}
            onChange={(event) => { setText(event.target.value); setOpen(true); setActive(0); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
            placeholder={property ? t("ui.propertyLabelValue", { propertyLabel: property.label }) : placeholder}
            ref={input}
            role="combobox"
            value={text}
          />
        </div>
        <div aria-label={property ? t("ui.propertyLabelValues", { propertyLabel: property.label }) : t("ui.filterBy")} className="c-filter-menu" hidden={!open || options.length === 0} id={listId} role="listbox">
          <div aria-labelledby={`${listId}-label`} role="group">
            <div className="c-filter-menu-label" id={`${listId}-label`}>{property ? property.label : t("ui.filterBy")}</div>
            {options.map((option, index) => (
              <div
                aria-selected={index === at}
                className="c-filter-option"
                id={`${listId}-${index}`}
                key={option.key}
                onMouseDown={(event) => { event.preventDefault(); option.pick(); }}
                onMouseMove={() => setActive(index)}
                role="option" // NOSONAR options are chosen through aria-activedescendant; focus stays on the input
              >
                <span>{option.label}</span>
                {option.count !== undefined && <span className="c-filter-option-count">{option.count}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* The end group is drawn only with something in it, so an empty one leaves no gap after the field. */}
      {(showMatches || clearable || end) && (
        <div className="c-filterbar-end">
          {showMatches && <span className="c-filter-matches">{t("ui.matchCount", { count: matches })}</span>}
          {clearable && <ActionButton action={action("filter.clear", t("ui.clear"), () => onChange([]))} size="sm" variant="ghost" />}
          {end}
        </div>
      )}
    </div>
  );
}
