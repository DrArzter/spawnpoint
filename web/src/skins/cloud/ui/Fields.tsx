import { createContext, useContext, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

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

export function Field({ label, error, end, className, children }: Readonly<{
  label: string;
  /** Why the value cannot be used; one line. */
  error?: string | null;
  /** Something at the end of the label row, such as a count or a link. */
  end?: ReactNode;
  className?: string;
  children: ReactNode;
}>) {
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;
  return (
    <FieldContext.Provider value={{ id, errorId, invalid: Boolean(error) }}>
      <div className={cx("c-field", className)}>
        <span className="c-field-label-row">
          <label className="c-field-label" htmlFor={id}>{label}</label>
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

export function NumberInput({ className, ...rest }: Readonly<Omit<InputHTMLAttributes<HTMLInputElement>, "type">>) {
  return <input className={cx("c-input", "c-input-number", className)} inputMode="numeric" type="number" {...controlProps(useWiring())} {...rest} />;
}

export function TextArea({ className, ...rest }: Readonly<TextareaHTMLAttributes<HTMLTextAreaElement>>) {
  return <textarea className={cx("c-input", "c-textarea", className)} {...controlProps(useWiring())} {...rest} />;
}

export type SelectOption = Readonly<{ value: string; label: string; disabled?: boolean }>;

/** A native select with the skin's chevron. `inline` sits in a toolbar or a table row at its content's width. */
export function Select({ options, inline = false, className, ...rest }: Readonly<{ options: readonly SelectOption[]; inline?: boolean } & SelectHTMLAttributes<HTMLSelectElement>>) {
  return (
    <span className={cx("c-select", inline && "c-select-inline", className)}>
      <select className="c-input" {...controlProps(useWiring())} {...rest}>
        {options.map((option) => <option disabled={option.disabled} key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <Icon className="c-select-chevron" name="expand_more" size={20} />
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

export function Checkbox({ checked, onChange, label, labelHidden = false, disabled = false }: Readonly<{ checked: boolean | "mixed"; onChange: (checked: boolean) => void; label: string; labelHidden?: boolean; disabled?: boolean }>) {
  return (
    <label className="c-checkbox">
      <input
        aria-checked={checked === "mixed" ? "mixed" : undefined}
        aria-label={labelHidden ? label : undefined}
        checked={checked === true}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        ref={(element) => { if (element) element.indeterminate = checked === "mixed"; }}
        type="checkbox"
      />
      {!labelHidden && <span>{label}</span>}
    </label>
  );
}

export type RadioCardOption<Value extends string> = Readonly<{ value: Value; label: string; icon?: IconName; disabled?: boolean; /** Why it cannot be chosen, as its tooltip. */ hint?: string }>;

/** A choice of a few, as cards with a radio ring: hosting, connection, theme. */
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
      <div className="c-radios-row">
        {options.map((option) => (
          <label className={cx("c-radio", option.disabled && "c-radio-disabled")} data-tip={option.disabled ? option.hint : undefined} key={option.value}>
            <input checked={option.value === value} disabled={option.disabled} name={name} onChange={() => onChange(option.value)} type="radio" value={option.value} />
            <span className="c-radio-label">{option.label}</span>
            {option.icon && <Icon className="c-radio-icon" name={option.icon} size={20} />}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
