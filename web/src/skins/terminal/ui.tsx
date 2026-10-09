import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ComponentPropsWithRef, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes } from "react";

import type { StatusKind } from "../../components/ui/Status";
import { Tooltip } from "../../components/ui/Tooltip";
import type { Action } from "../../core/actions";
import { Icon, type IconName } from "../../icons";
import { cx } from "../../lib/cx";
import { useRevealSelectedTab } from "../../lib/revealTab";

/*
 * The terminal's own vocabulary. Every control here is drawn from scratch in
 * the face's grammar: a verb is its word between brackets, a state is a mark
 * and a word, a panel is a box with its name set into the top rule. Nothing
 * here leans on the console's components or its stylesheet; the classes are
 * the face's own (t-*), and terminal.css is the only place they are styled.
 */

// --- marks and states --------------------------------------------------------

export const MARKS: Readonly<Record<StatusKind, string>> = {
  ok: "[*]", ready: "[>]", off: "[-]", pending: "[.]", unknown: "[?]", error: "[!]", warning: "[!]", info: "[i]", archived: "[x]", absent: "[+]", progress: "[~]",
};

export function Mark({ kind, className }: Readonly<{ kind: StatusKind; className?: string }>) {
  if (kind === "progress") return <span aria-hidden="true" className={cx("t-mark", "t-mark-progress", className)} />;
  return <span aria-hidden="true" className={cx("t-mark", `t-mark-${kind}`, className)}>{MARKS[kind]}</span>;
}

export function State({ kind, label, size = "medium", className }: Readonly<{ kind: StatusKind; label: string; size?: "medium" | "large"; className?: string }>) {
  return (
    <span className={cx("t-state", `t-state-${kind}`, size === "large" && "t-state-large", className)}>
      <Mark kind={kind} />
      <span>{label}</span>
    </span>
  );
}

/** A compact state for dense rows: the mark stays visible and the label moves
    into the tooltip without becoming inaccessible to readers. */
export function Indicator({ kind, label, className }: Readonly<{ kind: StatusKind; label: string; className?: string }>) {
  return (
    <Tooltip className={cx("t-indicator", className)} text={label}>
      <Mark kind={kind} />
      <span className="visually-hidden">{label}</span>
    </Tooltip>
  );
}

/** One announced loading region. Its children preserve the geometry of the
    content that will replace them, without repeating loading copy. */
export function SkeletonGroup({ label, children, className }: Readonly<{ label: string; children: ReactNode; className?: string }>) {
  return (
    <div aria-busy="true" aria-live="polite" className={cx("t-skeleton-group", className)}>
      <span className="visually-hidden">{label}</span>
      {children}
    </div>
  );
}

/** Geometry-only loading content. A plot uses discrete terminal traces; text
    uses a quiet block sized by the same small vocabulary everywhere. */
export function Skeleton({ variant = "text", width = "medium", className }: Readonly<{
  variant?: "text" | "plot";
  width?: "short" | "medium" | "long";
  className?: string;
}>) {
  return (
    <span aria-hidden="true" className={cx("t-skeleton", `t-skeleton-${variant}`, variant === "text" && `t-skeleton-${width}`, className)}>
      {variant === "plot" && Array.from({ length: 7 }, (_, index) => <span className="t-skeleton-trace" key={index} />)}
    </span>
  );
}

/** Repeated list-shaped placeholders. The column contract is intentionally
    small so lists, drawers and preference rows do not invent their own wait. */
export function SkeletonRows({ label, rows = 3, columns = 2, className }: Readonly<{
  label: string;
  rows?: number;
  columns?: 1 | 2 | 3;
  className?: string;
}>) {
  return (
    <SkeletonGroup className={cx("t-skeleton-rows", className)} label={label}>
      {Array.from({ length: rows }, (_, row) => (
        <span aria-hidden="true" className={cx("t-skeleton-row", `t-skeleton-cols-${columns}`)} key={row}>
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} width={column === 0 ? "long" : (row + column) % 2 === 0 ? "medium" : "short"} />
          ))}
        </span>
      ))}
    </SkeletonGroup>
  );
}

export function Ghost({ children }: Readonly<{ children: ReactNode }>) {
  return <span className="t-ghost">{children}</span>;
}

// --- verbs --------------------------------------------------------------------

export type VerbTone = "plain" | "primary" | "danger";

type KeyProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & Readonly<{
  label: ReactNode;
  busy?: boolean;
  tone?: VerbTone;
  size?: "small" | "medium";
}>;

/** A key on the terminal: its word between brackets. */
export function Key({ label, busy = false, tone = "plain", size = "medium", className, type = "button", ...props }: KeyProps) {
  return (
    <button className={cx("t-verb", `t-verb-${tone}`, size === "small" && "t-verb-small", className)} type={type} {...props}>
      <span aria-hidden="true" className="t-bracket">[</span>
      {busy && <Mark className="t-verb-icon" kind="progress" />}
      <span className="t-verb-label">{label}</span>
      <span aria-hidden="true" className="t-bracket">]</span>
    </button>
  );
}

/** A model's action as a key, carrying `data-action` for the contract. */
export function Verb({ action, tone = "plain", size, className, tooltipWhenDisabled = false, ...rest }: Readonly<{ action: Action; tone?: VerbTone; size?: "small" | "medium"; className?: string; tooltipWhenDisabled?: boolean }> & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "disabled" | "children">) {
  const button = (
    <Key
      aria-label={action.disabled && action.hint ? `${action.label}. ${action.hint}` : undefined}
      busy={action.busy}
      className={className}
      data-action={action.id}
      disabled={action.disabled}
      label={action.label}
      onClick={action.run}
      size={size}
      title={action.disabled ? undefined : action.hint}
      tone={action.danger ? "danger" : tone}
      {...rest}
    />
  );
  return tooltipWhenDisabled && action.disabled && action.hint ? <Tooltip text={action.hint}>{button}</Tooltip> : button;
}

/** An icon alone between brackets, for a control whose word is its label. */
export function IconKey({ icon, label, size = "medium", className, ...props }: Omit<ComponentPropsWithRef<"button">, "children"> & Readonly<{ icon: IconName; label: string; size?: "small" | "medium" }>) {
  return (
    <button aria-label={label} className={cx("t-verb", "t-verb-plain", "t-verb-icon-only", size === "small" && "t-verb-small", className)} title={label} type="button" {...props}>
      <span aria-hidden="true" className="t-bracket">[</span>
      <Icon name={icon} size={16} />
      <span aria-hidden="true" className="t-bracket">]</span>
    </button>
  );
}

/** A row of keys. It reads from the left, as every line here does. */
export function Verbs({ children, className, align = "start" }: Readonly<{ children: ReactNode; className?: string; align?: "start" | "end" }>) {
  return <div className={cx("t-verbs", align === "end" && "t-verbs-end", className)}>{children}</div>;
}

/** Copies a value to the clipboard; the key says so for a moment. */
export function Copy({ value, label, size = "medium" }: Readonly<{ value: string; label: string; size?: "small" | "medium" }>) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 1600);
    return () => window.clearTimeout(timer);
  }, [done]);
  return (
    <IconKey
      className="t-copy"
      icon={done ? "check" : "content_copy"}
      label={done ? "Copied" : label}
      onClick={() => { navigator.clipboard?.writeText(value).then(() => setDone(true)).catch(() => undefined); }}
      size={size}
    />
  );
}

// --- choices and toggles --------------------------------------------------------

export function Choices({ label, children, className }: Readonly<{ label: string; children: ReactNode; className?: string }>) {
  return (
    <fieldset className={cx("t-choices", className)}>
      <legend className="visually-hidden">{label}</legend>
      {children}
    </fieldset>
  );
}

/** One of a row of options: a radio drawn in glyphs, (o) for the chosen. */
export function Choice({ pressed, children, className, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & Readonly<{ pressed: boolean; children: ReactNode }>) {
  return (
    <button aria-pressed={pressed} className={cx("t-choice", pressed && "t-choice-on", className)} type="button" {...props}>
      <span aria-hidden="true" className="t-choice-box">{pressed ? "(o)" : "( )"}</span>
      <span>{children}</span>
    </button>
  );
}

/** A switch as a terminal draws one: a box that is ticked or not. */
export function Toggle({ action, checked, note, labelHidden = false, className }: Readonly<{ action: Action; checked: boolean; note?: string; labelHidden?: boolean; className?: string }>) {
  return (
    <button aria-checked={checked} className={cx("t-toggle", checked && "t-toggle-on", className)} data-action={action.id} disabled={action.disabled} onClick={action.run} role="switch" title={action.hint} type="button">
      <span aria-hidden="true" className="t-toggle-box">{checked ? "[x]" : "[ ]"}</span>
      <span className="t-toggle-copy">
        <span className={labelHidden ? "visually-hidden" : undefined}>{action.label}</span>
        {note && <small>{note}</small>}
      </span>
    </button>
  );
}

// --- fields -------------------------------------------------------------------

export function Field({ label, hint, hideLabel = false, children, className }: Readonly<{ label: string; hint?: ReactNode; hideLabel?: boolean; children: ReactNode; className?: string }>) {
  return (
    <label className={cx("t-field", className)}>
      <span className={cx("t-field-label", hideLabel && "visually-hidden")}>{label}</span>
      {children}
      {hint && <small className="t-field-hint">{hint}</small>}
    </label>
  );
}

export function TextInput({ className, mono = false, ...props }: Omit<ComponentPropsWithRef<"input">, "className"> & Readonly<{ className?: string; mono?: boolean }>) {
  return <input className={cx("t-input", mono && "t-input-mono", className)} {...props} />;
}

export function SelectInput({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cx("t-select-well", className)}>
      <select className="t-input t-select" {...props}>{children}</select>
      <span aria-hidden="true" className="t-select-caret">▾</span>
    </span>
  );
}

// --- surfaces -----------------------------------------------------------------

export function Page({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <div className={cx("t-page", className)}>{children}</div>;
}

/** A box with its name set into the top rule and its verbs in the rule's
    other end; a box without a name keeps its verbs in a head line. */
export function Panel({ name, verbs, description, head, children, flush = false, className }: Readonly<{
  name?: string;
  verbs?: ReactNode;
  description?: ReactNode;
  head?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}>) {
  const id = useId();
  const inRule = Boolean(name && verbs);
  return (
    <section aria-labelledby={name ? id : undefined} className={cx("t-panel", name && "t-panel-named", flush && "t-panel-flush", className)}>
      {name && <h2 className="t-panel-name" id={id}>{name}</h2>}
      {inRule && <div className="t-panel-rule-verbs">{verbs}</div>}
      {(description || head || (verbs && !inRule)) && (
        <div className="t-panel-head">
          {description && <p className="t-panel-desc">{description}</p>}
          {head}
          {verbs && !inRule && <div className="t-panel-verbs">{verbs}</div>}
        </div>
      )}
      <div className="t-panel-body">{children}</div>
    </section>
  );
}

export type NoticeTone = "info" | "warning" | "error" | "success";
const noticeMark: Readonly<Record<NoticeTone, StatusKind>> = { info: "info", warning: "warning", error: "error", success: "ok" };

export function Notice({ tone, title, description, verbs, className }: Readonly<{ tone: NoticeTone; title: ReactNode; description?: ReactNode; verbs?: ReactNode; className?: string }>) {
  return (
    <div aria-live={tone === "error" ? undefined : "polite"} className={cx("t-notice", `t-notice-${tone}`, className)} role={tone === "error" ? "alert" : undefined}>
      <Mark kind={noticeMark[tone]} />
      <div className="t-notice-copy">
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      {verbs && <div className="t-notice-verbs">{verbs}</div>}
    </div>
  );
}

export function Empty({ title, description, verbs, className }: Readonly<{ title: ReactNode; description?: ReactNode; verbs?: ReactNode; className?: string }>) {
  return (
    <div className={cx("t-empty", className)}>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {verbs}
    </div>
  );
}

export function Help({ text }: Readonly<{ text: string }>) {
  return <Tooltip className="t-help" text={text}><span aria-hidden="true">(?)</span><span className="visually-hidden">{text}</span></Tooltip>;
}

export function Avatar({ name, photoUrl, size = "medium", className }: Readonly<{ name: string; photoUrl?: string | null; size?: "small" | "medium" | "large"; className?: string }>) {
  return (
    <span aria-hidden="true" className={cx("t-avatar", `t-avatar-${size}`, className)}>
      {photoUrl ? <img alt="" src={photoUrl} /> : (name.trim().charAt(0) || "?").toUpperCase()}
    </span>
  );
}

/** The one person row used by access requests, identities and pickers. */
export function Person({ name, detail, photoUrl, className }: Readonly<{ name: string; detail?: ReactNode; photoUrl?: string | null; className?: string }>) {
  return (
    <span className={cx("t-person", className)}>
      <Avatar name={name} photoUrl={photoUrl} />
      <span className="t-stack">
        <strong>{name}</strong>
        {detail && <small>{detail}</small>}
      </span>
    </span>
  );
}

// --- tabs -----------------------------------------------------------------------

export type TabOption<T extends string> = Readonly<{ id: T; label: string; count?: number }>;

export function Tabs<T extends string>({ label, options, value, onChange, className }: Readonly<{ label: string; options: readonly TabOption<T>[]; value: T; onChange: (id: T) => void; className?: string }>) {
  const strip = useRef<HTMLDivElement>(null);
  useRevealSelectedTab(strip, value);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = options.findIndex((option) => option.id === value);
    const next = options[(index + (event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length];
    if (next) {
      event.preventDefault();
      onChange(next.id);
      (event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[options.indexOf(next)])?.focus();
    }
  }
  return (
    <div aria-label={label} className={cx("t-tabs", className)} data-scroll="expected" onKeyDown={onKeyDown} ref={strip} role="tablist" tabIndex={-1}>
      {options.map((option) => (
        <button aria-selected={option.id === value} className="t-tab" key={option.id} onClick={() => onChange(option.id)} role="tab" tabIndex={option.id === value ? 0 : -1} type="button">
          {option.label}
          {option.count !== undefined && <span className="t-tab-count">[{option.count}]</span>}
        </button>
      ))}
    </div>
  );
}

// --- tables ---------------------------------------------------------------------

export type Col<Row> = Readonly<{
  id: string;
  label: string;
  render: (row: Row) => ReactNode;
  width?: string;
  align?: "start" | "end";
  /** The column of a row's verbs: no heading, packed against the end. */
  verbs?: boolean;
  /** On compact records, pin this one icon-only menu to the upper corner. */
  corner?: boolean;
  /** On compact records, put the value below its label instead of beside it. */
  compactBlock?: boolean;
  secondary?: boolean;
  /** Worth reading, not worth the row scrolling: dropped at the medium step. */
  optional?: boolean;
}>;

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function Table<Row>({ columns, rows, rowKey, label, loading = false, loadingLabel, loadingRows = 3, empty, headless = false, decision = false, className }: Readonly<{
  columns: readonly Col<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  label: string;
  loading?: boolean;
  loadingLabel?: string;
  loadingRows?: number;
  empty: ReactNode;
  headless?: boolean;
  /** A person, one compact choice and one action. Both access tables use it. */
  decision?: boolean;
  className?: string;
}>) {
  return (
    <div className={cx("t-table-wrap", decision && "t-table-decision", className)}>
      <table aria-busy={loading || undefined} aria-label={loading ? `${label}. ${loadingLabel ?? `Loading ${lowerFirst(label)}`}` : label} aria-live={loading ? "polite" : undefined} className={cx("t-table", headless && "t-table-headless")}>
        <thead className={headless ? "visually-hidden" : undefined}>
          <tr>{columns.map((column) => <th className={cx(column.align === "end" && "t-end", column.verbs && "t-verbs-col", column.corner && "t-corner-col", column.compactBlock && "t-compact-block", column.optional && "t-optional")} key={column.id} scope="col" style={column.width ? { width: column.width } : undefined}>{column.verbs ? <span className="visually-hidden">{column.label}</span> : column.label}</th>)}</tr>
        </thead>
        <tbody>
          {loading && Array.from({ length: loadingRows }, (_, row) => (
            <tr aria-hidden="true" className="t-table-skeleton" key={`skeleton-${row}`}>
              {columns.map((column, columnIndex) => <td className={cx(column.align === "end" && "t-end", column.verbs && "t-verbs-col", column.corner && "t-corner-col", column.compactBlock && "t-compact-block", column.secondary && "t-secondary", column.optional && "t-optional")} data-label={column.verbs ? "" : column.label} key={column.id} style={column.width ? { width: column.width } : undefined}><Skeleton width={column.verbs ? "short" : (row + columnIndex) % 3 === 0 ? "long" : "medium"} /></td>)}
            </tr>
          ))}
          {!loading && rows.length === 0 && <tr className="t-table-state"><td colSpan={columns.length}>{empty}</td></tr>}
          {!loading && rows.map((row) => (
            <tr className={columns.some((column) => column.corner) ? "t-row-corner" : undefined} key={rowKey(row)}>
              {columns.map((column) => <td className={cx(column.align === "end" && "t-end", column.verbs && "t-verbs-col", column.corner && "t-corner-col", column.compactBlock && "t-compact-block", column.secondary && "t-secondary", column.optional && "t-optional")} data-label={column.verbs ? "" : column.label} key={column.id} style={column.width ? { width: column.width } : undefined}>{column.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- details --------------------------------------------------------------------

export type DetailRow = Readonly<{ label: string; value: ReactNode; hint?: ReactNode; explain?: string; copy?: string }>;

export function Details({ items, label, className }: Readonly<{ items: readonly DetailRow[]; label?: string; className?: string }>) {
  return (
    <div className={cx("t-details-wrap", className)}>
      <dl aria-label={label} className="t-details">
        {items.map((item) => (
          <div className="t-detail" key={item.label}>
            <dt>{item.label}{item.explain && <Help text={item.explain} />}</dt>
            <dd>
              <span className="t-detail-value">{item.value}{item.copy && <Copy label={`Copy ${item.label.toLowerCase()}`} value={item.copy} />}</span>
              {item.hint && <small>{item.hint}</small>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function DetailsGroup({ title, items, level = 3 }: Readonly<{ title: string; items: readonly DetailRow[]; level?: 2 | 3 }>) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section className="t-details-group">
      <Heading className="t-group-name">{title}</Heading>
      <Details items={items} label={title} />
    </section>
  );
}

export function Address({ value, connectivity, network, copyLabel, size = "medium" }: Readonly<{ value: string; connectivity: "zerotier" | "route53" | "raw"; network: string; copyLabel?: string; size?: "small" | "medium" }>) {
  return (
    <span className="t-address">
      <span className="t-address-net" title={network}><Icon name={connectivity === "zerotier" ? "dns" : "public"} size={14} /><span className="visually-hidden">{network}</span></span>
      <code className="t-address-value">{value}</code>
      {copyLabel && <Copy label={copyLabel} size={size} value={value} />}
    </span>
  );
}

// --- overflow menu ---------------------------------------------------------------

/** The overflow: a key that opens a list of verbs in the top layer. */
export function Overflow({ label, groups, size = "medium", className }: Readonly<{ label: string; groups: readonly (readonly Action[])[]; size?: "small" | "medium"; className?: string }>) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const present = groups.filter((group) => group.length > 0);

  function show() {
    const button = trigger.current;
    const menu = panel.current;
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    const width = 240;
    const count = present.reduce((sum, group) => sum + group.length, 0);
    const estimated = 16 + count * 40 + (present.length - 1) * 9;
    const anchored = rect.left + rect.width / 2 < window.innerWidth / 2 ? rect.left : rect.right - width;
    const left = Math.max(8, Math.min(anchored, window.innerWidth - width - 8));
    const below = rect.bottom + 4;
    menu.style.left = `${left}px`;
    menu.style.top = below + estimated > window.innerHeight ? `${Math.max(8, rect.top - estimated - 4)}px` : `${below}px`;
    menu.style.width = `${width}px`;
    if (typeof menu.showPopover === "function") menu.showPopover();
    setOpen(true);
    window.requestAnimationFrame(() => menu.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus());
  }

  function hide() {
    const menu = panel.current;
    if (menu && typeof menu.hidePopover === "function" && menu.matches(":popover-open")) menu.hidePopover();
    setOpen(false);
  }

  useEffect(() => {
    const menu = panel.current;
    if (!menu) return;
    const onToggle = (event: Event) => { if ((event as ToggleEvent).newState === "closed") setOpen(false); };
    menu.addEventListener("toggle", onToggle);
    return () => menu.removeEventListener("toggle", onToggle);
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"));
    const index = focusable.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusable[(index + (event.key === "ArrowDown" ? 1 : -1) + focusable.length) % focusable.length]?.focus();
    }
    if (event.key === "Escape" || event.key === "Tab") {
      hide();
      trigger.current?.focus();
    }
  }

  return (
    <>
      <IconKey aria-controls={id} aria-expanded={open} aria-haspopup="menu" className={className} icon="more_vert" label={label} onClick={() => (open ? hide() : show())} ref={trigger} size={size} />
      <div className="t-menu" id={id} onKeyDown={onKeyDown} popover="auto" ref={panel} role="menu" tabIndex={-1}>
        {present.map((group, groupIndex) => (
          <div className="t-menu-group" key={group[0]?.id ?? groupIndex}>
            {groupIndex > 0 && <hr />}
            {group.map((action) => (
              <button className={cx("t-menu-item", action.danger && "t-menu-item-danger")} data-action={action.id} disabled={action.disabled} key={action.id} onClick={() => { hide(); action.run(); }} role="menuitem" title={action.hint} type="button">
                <span aria-hidden="true" className="t-bracket">{action.icon ? <Icon name={action.icon} size={16} /> : "-"}</span>
                <span className="t-menu-copy">{action.label}{action.detail && <small>{action.detail}</small>}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

// --- top layer: modal and drawer -------------------------------------------------

function useModal(open: boolean, onClose: () => void, dismissOnBackdrop = false) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
      if (!dialog.contains(document.activeElement) || document.activeElement === dialog) dialog.querySelector<HTMLElement>(".t-dialog-body")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const cancel = (event: Event) => { event.preventDefault(); onClose(); };
    dialog.addEventListener("cancel", cancel);
    return () => dialog.removeEventListener("cancel", cancel);
  }, [onClose]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !dismissOnBackdrop) return;
    const click = (event: Event) => { if (event.target === dialog) onClose(); };
    dialog.addEventListener("click", click);
    return () => dialog.removeEventListener("click", click);
  }, [dismissOnBackdrop, onClose]);
  return ref;
}

/** A question in the middle of the screen: a panel over a dimmed page. */
export function Modal({ open, onClose, title, children, verbs, className, dismissOnBackdrop = true }: Readonly<{
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  verbs?: ReactNode;
  className?: string;
  dismissOnBackdrop?: boolean;
}>) {
  const ref = useModal(open, onClose, dismissOnBackdrop);
  const titleId = useId();
  return (
    <dialog aria-labelledby={titleId} className={cx("t-modal", className)} ref={ref}>
      {open && (
        <div className="t-panel t-modal-panel">
          <div className="t-dialog-head">
            <h2 className="t-dialog-title" id={titleId}>{title}</h2>
          </div>
          <div className="t-panel-body t-modal-body t-dialog-body" tabIndex={-1}>{children}</div>
          {verbs && <div className="t-modal-verbs">{verbs}</div>}
        </div>
      )}
    </dialog>
  );
}

/** A form or a reading in the middle of the screen: the same box as a
    question, with a close key and a scrolling body. */
export function Drawer({ open, onClose, title, description, children, footer, closeActionId, cancel, cancelLabel = "Cancel", className }: Readonly<{
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  closeActionId?: string;
  cancel?: Action;
  cancelLabel?: string;
  className?: string;
}>) {
  const ref = useModal(open, onClose);
  const titleId = useId();
  return (
    <dialog aria-labelledby={titleId} className={cx("t-drawer", className)} ref={ref}>
      {open && (
        <div className="t-panel t-drawer-panel">
          <div className="t-dialog-head">
            <h2 className="t-dialog-title" id={titleId}>{title}</h2>
            <IconKey data-action={closeActionId} icon="close" label="Close panel" onClick={onClose} />
          </div>
          <div className="t-drawer-body t-dialog-body" tabIndex={-1}>
            {description && <p className="t-drawer-desc">{description}</p>}
            {children}
          </div>
          {(footer || cancel) && (
            <footer className="t-drawer-foot">
              {footer}
              {cancel && <Key data-action={cancel.id} disabled={cancel.disabled} label={cancelLabel} onClick={cancel.run} />}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}
