import { createContext, useContext, useId, useMemo, type CSSProperties, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

import type { Action } from "../../../core/actions";
import { Icon, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";
import { actionTip } from "./ActionButton";

/*
 * Form controls. A Field gives its control a label above it and, when the
 * value cannot be used, one line that says why, tied to the control with
 * aria-describedby and aria-invalid. Controls read their wiring from the
 * Field they sit in.
 */

type Wiring = Readonly<{ id: string; errorId: string | undefined; invalid: boolean }>;

const FieldContext = createContext<Wiring | null>(null);

function useWiring(): Partial<Wiring> {
  return useContext(FieldContext) ?? {};
}

export function Field({ label, error, hint, end, className, children }: Readonly<{
  label: string;
  /** Why the value cannot be used; one line. */
  error?: string | null;
  /** A short definition of the field, as an info mark's tooltip after the label. */
  hint?: string;
  /** Something at the end of the label row, such as a count or a link. */
  end?: ReactNode;
  className?: string;
  children: ReactNode;
}>) {
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;
  const invalid = Boolean(error);
  const wiring = useMemo(() => ({ id, errorId, invalid }), [id, errorId, invalid]);
  return (
    <FieldContext.Provider value={wiring}>
      <div className={cx("c-field", className)}>
        <span className="c-field-label-row">
          <span className="c-field-label-start">
            <label className="c-field-label" htmlFor={id}>{label}</label>
            {hint && <span aria-label={hint} className="c-field-hint" data-tip={hint} role="img" tabIndex={0 /* NOSONAR focusable tooltip trigger */}><Icon name="info" size={15} /></span>}
          </span>
          {end}
        </span>
        {children}
        {error && <span className="c-field-error" id={errorId}>{error}</span>}
      </div>
    </FieldContext.Provider>
  );
}

function controlProps(wiring: Partial<Wiring>) {
  return { id: wiring.id, "aria-invalid": wiring.invalid || undefined, "aria-describedby": wiring.errorId };
}

export function TextInput({ mono = false, className, ...rest }: Readonly<{ mono?: boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { type?: "text" | "email" | "password" | "search" | "url" }>) {
  return <input className={cx("c-input", mono && "c-mono", className)} type="text" {...controlProps(useWiring())} {...rest} />;
}

/** Text of many lines at a fixed, monospaced layout: no wrapping, so a line of a config file keeps its columns. */
export function TextArea({ className, ...rest }: Readonly<TextareaHTMLAttributes<HTMLTextAreaElement>>) {
  return <textarea className={cx("c-textarea", "c-mono", className)} spellCheck={false} {...controlProps(useWiring())} {...rest} />;
}

export function NumberInput({ className, ...rest }: Readonly<Omit<InputHTMLAttributes<HTMLInputElement>, "type">>) {
  return <input className={cx("c-input", "c-input-number", className)} inputMode="numeric" type="number" {...controlProps(useWiring())} {...rest} />;
}

/** A native colour well at the field's height, for a colour the person picks (the accent). */
export function ColourInput({ className, ...rest }: Readonly<Omit<InputHTMLAttributes<HTMLInputElement>, "type">>) {
  return <input className={cx("c-input", "c-input-colour", className)} type="color" {...controlProps(useWiring())} {...rest} />;
}

export type SelectOption = Readonly<{ value: string; label: string; disabled?: boolean }>;

/** A native select with the skin's chevron. `inline` sits in a toolbar or a table row at its content's width. */
export function Select({ options, inline = false, className, ...rest }: Readonly<{ options: readonly SelectOption[]; inline?: boolean } & SelectHTMLAttributes<HTMLSelectElement>>) {
  return (
    <span className={cx("c-select", inline && "c-select-inline", className)}>
      <select className="c-input" {...controlProps(useWiring())} {...rest}>
        {options.map((option) => <option disabled={option.disabled} key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <Icon className="c-select-chevron" data-layer="glyph" name="expand_more" size={20} />
    </span>
  );
}

/**
 * A switch bound to a model Action that flips it (game settings, a
 * notification). It carries the Action's data-action and stays focusable
 * while refused.
 */
export function Toggle({ action, checked, label, showLabel = false }: Readonly<{ action: Action; checked: boolean; /** The accessible name; the Action's label when left out. */ label?: string; showLabel?: boolean }>) {
  const refused = action.disabled === true;
  return (
    <label className={cx("c-toggle", refused && "c-toggle-refused")} data-tip={actionTip(action)}>
      <span className="c-toggle-track">
        <input
          aria-disabled={refused || undefined}
          aria-label={showLabel ? undefined : label ?? action.label}
          checked={checked}
          data-action={action.id}
          onChange={() => { if (!refused && !action.busy) action.run(); }}
          role="switch"
          type="checkbox"
        />
        <span aria-hidden="true" className="c-toggle-thumb" />
      </span>
      {showLabel && <span className="c-toggle-label">{label ?? action.label}</span>}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, labelHidden = false, disabled = false, actionId, hint }: Readonly<{ checked: boolean | "mixed"; onChange: (checked: boolean) => void; label: string; labelHidden?: boolean; disabled?: boolean; /** The Action this box runs, so the skin contract finds it. */ actionId?: string; /** The tooltip: what the box means, or why it is refused. */ hint?: string }>) {
  return (
    <label className="c-checkbox" data-tip={hint}>
      <input
        aria-checked={checked === "mixed" ? "mixed" : undefined}
        aria-label={labelHidden ? label : undefined}
        checked={checked === true}
        data-action={actionId}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        ref={(element) => { if (element) element.indeterminate = checked === "mixed"; }}
        type="checkbox"
      />
      {!labelHidden && <span>{label}</span>}
    </label>
  );
}

export type RadioCardOption<Value extends string> = Readonly<{
  value: Value;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  /** Why it cannot be chosen, as its tooltip. */
  hint?: string;
  /** A model Action that chooses this card (a look); the card then carries its data-action and runs it. */
  action?: Action;
}>;

/**
 * A choice of a few, as cards with a radio ring: hosting, connection, theme,
 * look. Cards share one row in equal columns; under 480px each takes a row.
 * The checked card never reads as refused, even when its Action is (choosing
 * it again does nothing).
 */
export function RadioCards<Value extends string>({ legend, name, options, value, onChange, className }: Readonly<{
  legend: string;
  name: string;
  options: readonly RadioCardOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  className?: string;
}>) {
  return (
    <fieldset className={cx("c-radios", className)}>
      <legend className="c-field-label">{legend}</legend>
      <div className="c-radios-row" style={{ "--c-radio-count": options.length } as CSSProperties}>
        {options.map((option) => {
          const checked = option.value === value;
          const refused = !checked && (option.disabled === true || option.action?.disabled === true);
          const why = option.hint ?? option.action?.hint;
          const choose = () => {
            if (refused) return;
            onChange(option.value);
            if (option.action && !checked) option.action.run();
          };
          return (
            <label className={cx("c-radio", refused && "c-radio-disabled")} data-tip={refused ? why : undefined} key={option.value}>
              <input
                aria-disabled={refused || undefined}
                checked={checked}
                data-action={option.action?.id}
                name={name}
                onChange={choose}
                type="radio"
                value={option.value}
              />
              <span className="c-radio-label">{option.label}</span>
              {option.icon && <Icon className="c-radio-icon" name={option.icon} size={20} />}
              {refused && why && <span className="c-sr">, unavailable: {why}</span>}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
