import { useEffect, useId, useRef, type ReactNode } from "react";

import { cx } from "../../lib/cx";
import { IconButton } from "./Button";

// Native <dialog> in modal mode: top layer, focus trap, Escape, restored focus.
function useModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // The first field, when one is marked, beats the close button as the
      // landing point; the browser's default lands on the first control.
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const cancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", cancel);
    return () => dialog.removeEventListener("cancel", cancel);
  }, [onClose]);
  return ref;
}

export function Dialog({ open, onClose, title, children, actions, className, dismissOnBackdrop = true, brand }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  dismissOnBackdrop?: boolean;
  /**
   * What stands above the title: the mark and the name, for a dialog that is a
   * threshold rather than a question — sign-in is the one so far. It brings a
   * close button with it, because a threshold can be walked away from.
   */
  brand?: ReactNode;
}) {
  const ref = useModal(open, onClose);
  const titleId = useId();
  return (
    <dialog
      aria-labelledby={titleId}
      className={cx("dialog", className)}
      onClick={(event) => { if (dismissOnBackdrop && event.target === event.currentTarget) onClose(); }}
      ref={ref}
    >
      {open && (
        <div className="dialog-body">
          {brand && (
            <div className="dialog-brand">
              {brand}
              <IconButton icon="close" label="Close" onClick={onClose} size="small" />
            </div>
          )}
          <h2 id={titleId}>{title}</h2>
          {children && <div className="dialog-content">{children}</div>}
          {actions && <div className="dialog-actions">{actions}</div>}
        </div>
      )}
    </dialog>
  );
}

export function Sheet({ open, onClose, title, description, children, footer, className }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useModal(open, onClose);
  const titleId = useId();
  return (
    <dialog aria-labelledby={titleId} className={cx("sheet", className)} ref={ref}>
      {open && (
        <>
          <header className="sheet-header">
            <div>
              <h2 id={titleId}>{title}</h2>
              {description && <p>{description}</p>}
            </div>
            <IconButton icon="close" label="Close panel" onClick={onClose} />
          </header>
          <div className="sheet-body">{children}</div>
          {footer && <footer className="sheet-footer">{footer}</footer>}
        </>
      )}
    </dialog>
  );
}
