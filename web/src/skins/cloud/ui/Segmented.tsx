import { cx } from "../../../lib/cx";

export type SegmentOption<Value extends string> = Readonly<{ value: Value; label: string; count?: number }>;

/**
 * One value out of a few, as a pill track: a metric range, a backup wipe, an
 * invitation audience. A radio group by default; `pressed` for toggles that
 * filter. It scrolls sideways without a scrollbar when it overflows.
 */
export function Segmented<Value extends string>({ label, options, value, onChange, className }: Readonly<{
  label: string;
  options: readonly SegmentOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  className?: string;
}>) {
  const move = (step: number) => {
    const at = options.findIndex((option) => option.value === value);
    const next = options[(at + step + options.length) % options.length];
    if (next) onChange(next.value);
  };
  return (
    <div aria-label={label} className={cx("c-segmented", className)} role="radiogroup">
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            aria-checked={checked}
            className="c-segment"
            key={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); move(1); }
              if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); move(-1); }
            }}
            role="radio"
            tabIndex={checked ? 0 : -1}
            type="button"
          >
            <span>{option.label}</span>
            {option.count !== undefined && <span className="c-segment-count">{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
