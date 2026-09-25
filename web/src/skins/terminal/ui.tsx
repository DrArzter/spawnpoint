import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ComponentPropsWithRef, type KeyboardEvent, type MouseEvent, type ReactNode, type SelectHTMLAttributes } from "react";

import type { StatusKind } from "../../components/ui/Status";
import { Tooltip } from "../../components/ui/Tooltip";
import type { Action } from "../../core/actions";
import { Icon, type IconName } from "../../icons";
import { cx } from "../../lib/cx";

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

/** One line in the middle of a box while it waits; the same everywhere. */
export function Wait({ label, className }: Readonly<{ label: string; className?: string }>) {
  return (
    <div aria-busy="true" aria-live="polite" className={cx("t-wait", className)} role="status">
      <Mark kind="progress" />
      <span>{label}</span>
    </div>
  );
}

export function Ghost({ children }: Readonly<{ children: ReactNode }>) {
  return <span className="t-ghost">{children}</span>;
}

// --- verbs --------------------------------------------------------------------

export type VerbTone = "plain" | "primary" | "danger";

type KeyProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & Readonly<{
  label: ReactNode;
  icon?: IconName;
  busy?: boolean;
  tone?: VerbTone;
  size?: "small" | "medium";
  /** The word alone, no brackets: for a verb that sits inside a sentence. */
  bare?: boolean;
}>;

/** A key on the terminal: its word between brackets. */
export function Key({ label, icon, busy = false, tone = "plain", size = "medium", bare = false, className, type = "button", ...props }: KeyProps) {
  return (
    <button className={cx("t-verb", `t-verb-${tone}`, size === "small" && "t-verb-small", bare && "t-verb-bare", className)} type={type} {...props}>
      {!bare && <span aria-hidden="true" className="t-bracket">[</span>}
      {busy ? <Mark className="t-verb-icon" kind="progress" /> : icon && <Icon className="t-verb-icon" name={icon} size={16} />}
      <span className="t-verb-label">{label}</span>
      {!bare && <span aria-hidden="true" className="t-bracket">]</span>}
    </button>
  );
}

/** A model's action as a key, carrying `data-action` for the contract. */
export function Verb({ action, tone = "plain", size, className, hideIcon = false, ...rest }: Readonly<{ action: Action; tone?: VerbTone; size?: "small" | "medium"; className?: string; hideIcon?: boolean }> & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "disabled" | "children">) {
  return (
    <Key
      aria-label={action.disabled && action.hint ? `${action.label}. ${action.hint}` : undefined}
      busy={action.busy}
      className={className}
      data-action={action.id}
      disabled={action.disabled}
      icon={hideIcon ? undefined : action.icon}
      label={action.label}
      onClick={action.run}
      size={size}
      title={action.disabled ? undefined : action.hint}
      tone={action.danger ? "danger" : tone}
      {...rest}
    />
  );
}

/** An icon alone between brackets, for a control whose word is its label. */
export function IconKey({ icon, label, className, ...props }: Omit<ComponentPropsWithRef<"button">, "children"> & Readonly<{ icon: IconName; label: string }>) {
  return (
    <button aria-label={label} className={cx("t-verb", "t-verb-plain", "t-verb-icon-only", className)} title={label} type="button" {...props}>
      <span aria-hidden="true" className="t-bracket">[</span>
      <Icon name={icon} size={16} />
      <span aria-hidden="true" className="t-bracket">]</span>
    </button>
  );
}

export function Verbs({ children, className, align = "end" }: Readonly<{ children: ReactNode; className?: string; align?: "start" | "end" }>) {
  return <div className={cx("t-verbs", align === "start" && "t-verbs-start", className)}>{children}</div>;
}

/** Copies a value to the clipboard; the key says so for a moment. */
export function Copy({ value, label }: Readonly<{ value: string; label: string }>) {
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

/** One of a row of options; the chosen one is inverted. */
export function Choice({ pressed, children, icon, className, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & Readonly<{ pressed: boolean; icon?: IconName; children: ReactNode }>) {
  return (
    <button aria-pressed={pressed} className={cx("t-choice", pressed && "t-choice-on", className)} type="button" {...props}>
      <span aria-hidden="true" className="t-bracket">[</span>
      {icon && <Icon className="t-verb-icon" name={icon} size={16} />}
      <span>{children}</span>
      <span aria-hidden="true" className="t-bracket">]</span>
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

/** A box with its name set into the top rule, and its verbs in the head. */
export function Panel({ name, verbs, description, children, flush = false, className }: Readonly<{
  name?: string;
  verbs?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}>) {
  const id = useId();
  return (
    <section aria-labelledby={name ? id : undefined} className={cx("t-panel", name && "t-panel-named", flush && "t-panel-flush", className)}>
      {name && <h2 className="t-panel-name" id={id}>{name}</h2>}
      {(description || verbs) && (
        <div className="t-panel-head">
          {description && <p className="t-panel-desc">{description}</p>}
          {verbs && <div className="t-panel-verbs">{verbs}</div>}
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
    <div className={cx("t-notice", `t-notice-${tone}`, className)} role={tone === "error" ? "alert" : "status"}>
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

// --- tabs -----------------------------------------------------------------------

export type TabOption<T extends string> = Readonly<{ id: T; label: string; count?: number }>;

export function Tabs<T extends string>({ label, options, value, onChange, className }: Readonly<{ label: string; options: readonly TabOption<T>[]; value: T; onChange: (id: T) => void; className?: string }>) {
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
    <div aria-label={label} className={cx("t-tabs", className)} data-scroll="expected" onKeyDown={onKeyDown} role="tablist">
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
  secondary?: boolean;
  /** Worth reading, not worth the row scrolling: dropped at the medium step. */
  optional?: boolean;
}>;

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function Table<Row>({ columns, rows, rowKey, label, loading = false, loadingLabel, empty, headless = false, className }: Readonly<{
  columns: readonly Col<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  label: string;
  loading?: boolean;
  loadingLabel?: string;
  empty: ReactNode;
  headless?: boolean;
  className?: string;
}>) {
  return (
    <div className={cx("t-table-wrap", className)}>
      <table aria-busy={loading || undefined} aria-label={label} className={cx("t-table", headless && "t-table-headless")}>
        <thead className={headless ? "visually-hidden" : undefined}>
          <tr>{columns.map((column) => <th className={cx(column.align === "end" && "t-end", column.verbs && "t-verbs-col", column.optional && "t-optional")} key={column.id} scope="col" style={column.width ? { width: column.width } : undefined}>{column.verbs ? <span className="visually-hidden">{column.label}</span> : column.label}</th>)}</tr>
        </thead>
        <tbody>
          {loading && <tr className="t-table-state"><td colSpan={columns.length}><Wait label={loadingLabel ?? `Loading ${lowerFirst(label)}`} /></td></tr>}
          {!loading && rows.length === 0 && <tr className="t-table-state"><td colSpan={columns.length}>{empty}</td></tr>}
          {!loading && rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => <td className={cx(column.align === "end" && "t-end", column.verbs && "t-verbs-col", column.secondary && "t-secondary", column.optional && "t-optional")} data-label={column.verbs ? "" : column.label} key={column.id}>{column.render(row)}</td>)}
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
    <dl aria-label={label} className={cx("t-details", className)}>
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

export function Address({ value, connectivity, network, copyLabel }: Readonly<{ value: string; connectivity: "zerotier" | "route53" | "raw"; network: string; copyLabel?: string }>) {
  return (
    <span className="t-address">
      <span className="t-address-net" title={network}><Icon name={connectivity === "zerotier" ? "dns" : "public"} size={14} /><span className="visually-hidden">{network}</span></span>
      <code>{value}</code>
      {copyLabel && <Copy label={copyLabel} value={value} />}
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
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
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
      <IconKey aria-controls={id} aria-expanded={open} aria-haspopup="menu" className={cx(size === "small" && "t-verb-small", className)} icon="more_vert" label={label} onClick={() => (open ? hide() : show())} ref={trigger} />
      <div className="t-menu" id={id} onKeyDown={onKeyDown} popover="auto" ref={panel} role="menu">
        {present.map((group, groupIndex) => (
          <div className="t-menu-group" key={group[0]?.id ?? groupIndex} role="presentation">
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

function useModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
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
  const ref = useModal(open, onClose);
  const titleId = useId();
  const onClick = (event: MouseEvent<HTMLDialogElement>) => { if (dismissOnBackdrop && event.target === event.currentTarget) onClose(); };
  return (
    <dialog aria-labelledby={titleId} className={cx("t-modal", className)} onClick={onClick} ref={ref}>
      {open && (
        <div className="t-panel t-panel-named t-modal-panel">
          <h2 className="t-panel-name" id={titleId}>{title}</h2>
          <div className="t-panel-body t-modal-body">{children}</div>
          {verbs && <div className="t-modal-verbs">{verbs}</div>}
        </div>
      )}
    </dialog>
  );
}

/** A drawer from the right edge, the height of the screen. */
export function Drawer({ open, onClose, title, description, children, footer, closeActionId, className }: Readonly<{
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  closeActionId?: string;
  className?: string;
}>) {
  const ref = useModal(open, onClose);
  const titleId = useId();
  return (
    <dialog aria-labelledby={titleId} className={cx("t-drawer", className)} ref={ref}>
      {open && (
        <>
          <header className="t-drawer-head">
            <div className="t-drawer-title">
              <h2 id={titleId}>{title}</h2>
              {description && <p>{description}</p>}
            </div>
            <IconKey data-action={closeActionId} icon="close" label="Close panel" onClick={onClose} />
          </header>
          <div className="t-drawer-body">{children}</div>
          {footer && <footer className="t-drawer-foot">{footer}</footer>}
        </>
      )}
    </dialog>
  );
}
