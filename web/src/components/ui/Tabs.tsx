import type { KeyboardEvent } from "react";

import { Icon, IconName } from "../../icons";

export type TabOption<T extends string> = { id: T; label: string; icon?: IconName; count?: number };

export function Tabs<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
    onChange(options[next]!.id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  }

  // Scrolls sideways on a narrow screen by design — Material's own tab
  // behaviour, where the half-visible next tab is the affordance. The marker
  // tells the audit this scroller is deliberate.
  return (
    <div aria-label={label} className="tabs" data-scroll="expected" role="tablist">
      {options.map((option, index) => (
        <button
          aria-selected={value === option.id}
          className="tab"
          key={option.id}
          onClick={() => onChange(option.id)}
          onKeyDown={(event) => move(event, index)}
          role="tab"
          tabIndex={value === option.id ? 0 : -1}
          type="button"
        >
          {option.icon && <Icon name={option.icon} size={18} />}
          {option.label}
          {option.count !== undefined && <span className="count num">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}
