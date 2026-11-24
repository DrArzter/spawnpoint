import { useEffect, useId, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";

import type { Action } from "../../../core/actions";
import { cx } from "../../../lib/cx";
import { ActionButton } from "./ActionButton";
import { IconButton } from "./IconButton";
import { PANEL_MIN_WIDTH, usePanelWidth } from "./panel-width";

const FIRST_FIELD = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not(:disabled), select:not(:disabled), textarea:not(:disabled)";

/**
 * A native modal dialog for as long as it is mounted: it opens on its first
 * field (else on Cancel), Escape runs the model's cancel Action, and focus
 * goes back to whatever opened it.
 */
export function useModal(ref: RefObject<HTMLDialogElement | null>, cancel: Action) {
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    const first = dialog.querySelector<HTMLElement>(`.c-dialog-body :is(${FIRST_FIELD})`) ?? dialog.querySelector<HTMLElement>("[data-cancel] button") ?? dialog.querySelector<HTMLElement>(".c-dialog-body button");
    first?.focus();
    const onCancel = (event: Event) => {
      event.preventDefault();
      if (!cancelRef.current.disabled) cancelRef.current.run();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [ref]);
}

type Surface = Readonly<{
  title: string;
  /** Escape, the close button and the footer's first button run it. */
  cancel: Action;
  /** The footer's end: the primary or danger Action after Cancel. */
  actions?: ReactNode;
  /** The footer's start: a secondary control such as Restore defaults. */
  start?: ReactNode;
  children?: ReactNode;
}>;

const parts = {
  dialog: { root: "c-dialog", head: "c-dialog-head", foot: "c-dialog-foot" },
  panel: { root: "c-panel", head: "c-panel-head", foot: "c-panel-foot" },
} as const;

export function DialogFrame({ kind, title, cancel, actions, start, children, className, footer = true, resize }: Surface & Readonly<{
  kind: keyof typeof parts;
  className?: string;
  /** Draw the sticky footer with Cancel; a panel without one closes from its head, or with Escape. */
  footer?: boolean;
  /** The name a panel's dragged width is kept under; a panel always has one, a dialog never. */
  resize?: string;
}>) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useModal(ref, cancel);
  const part = parts[kind];
  const width = usePanelWidth(kind === "panel" ? resize : undefined);
  const resizable = kind === "panel" && resize !== undefined;
  const style = width.width === null ? undefined : ({ "--c-panel-width": `${width.width}px` } as CSSProperties);
  const close = () => { if (!cancel.disabled) cancel.run(); };
  return (
    <dialog aria-labelledby={titleId} className={cx(part.root, className)} data-resizing={width.dragging || undefined} ref={ref} style={style}>
      {resizable && (
        <div
          aria-label="Panel width"
          aria-orientation="vertical"
          aria-valuemax={width.max}
          aria-valuemin={PANEL_MIN_WIDTH}
          aria-valuenow={width.width ?? undefined}
          className="c-panel-grip"
          data-tip="Drag to resize. Double-click to reset."
          onDoubleClick={width.reset}
          onKeyDown={width.onKeyDown}
          onPointerDown={width.onPointerDown}
          role="separator"
          tabIndex={0}
        />
      )}
      <div className={part.head}>
        <h2 id={titleId} title={title}>{title}</h2>
        <IconButton data-action={footer ? undefined : cancel.id} disabled={cancel.disabled} icon="close" label={footer ? "Close" : cancel.label} onClick={close} />
      </div>
      <div className="c-dialog-body">{children}</div>
      {footer && (
        <div className={part.foot}>
          {start && <span className="c-dialog-start">{start}</span>}
          <span data-cancel="" className="c-dialog-cancel"><ActionButton action={cancel} /></span>
          {actions}
        </div>
      )}
    </dialog>
  );
}

/** A centred dialog, 520px (760px wide); docked to the bottom on a phone. */
export function Dialog({ wide = false, ...surface }: Surface & Readonly<{ wide?: boolean }>) {
  return <DialogFrame className={wide ? "c-dialog-wide" : undefined} kind="dialog" {...surface} />;
}
