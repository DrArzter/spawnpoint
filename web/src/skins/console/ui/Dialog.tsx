import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

import type { Action } from "../../../core/actions";
import { cx } from "../../../lib/cx";
import { ActionButton } from "./ActionButton";
import { IconButton } from "./IconButton";

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
    const first = dialog.querySelector<HTMLElement>(`.c-dialog-body :is(${FIRST_FIELD})`) ?? dialog.querySelector<HTMLElement>("[data-cancel] button");
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

export function DialogFrame({ kind, title, cancel, actions, start, children, className }: Surface & Readonly<{ kind: keyof typeof parts; className?: string }>) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useModal(ref, cancel);
  const part = parts[kind];
  return (
    <dialog aria-labelledby={titleId} className={cx(part.root, className)} ref={ref}>
      <div className={part.head}>
        <h2 id={titleId} title={title}>{title}</h2>
        <IconButton icon="close" label="Close" onClick={() => { if (!cancel.disabled) cancel.run(); }} />
      </div>
      <div className="c-dialog-body">{children}</div>
      <div className={part.foot}>
        {start && <span className="c-dialog-start">{start}</span>}
        <span data-cancel="" className="c-dialog-cancel"><ActionButton action={cancel} /></span>
        {actions}
      </div>
    </dialog>
  );
}

/** A centred dialog, 520px (760px wide); docked to the bottom on a phone. */
export function Dialog({ wide = false, ...surface }: Surface & Readonly<{ wide?: boolean }>) {
  return <DialogFrame className={wide ? "c-dialog-wide" : undefined} kind="dialog" {...surface} />;
}
