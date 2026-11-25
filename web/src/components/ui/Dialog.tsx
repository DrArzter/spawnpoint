import { useEffect, useId, useRef, type ReactNode } from "react";

import { cx } from "../../lib/cx";
import { IconButton } from "./Button";
import { t } from "../../i18n";

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

export function Dialog({ open, onClose, title, children, actions, className, dismissOnBackdrop = true, brand, closeActionId }: Readonly<{
  open: boolean;
  closeActionId?: string;
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
}>) {
  const ref = useModal(open, onClose);
  const titleId = useId();
  return (
    <dialog
      aria-labelledby={titleId}
      className={cx("dialog", className)}
      onClick={(event) => { if (dismissOnBackdrop && event.target === event.currentTarget) onClose(); }} // NOSONAR backdrop click is a pointer shortcut; Escape closes the native dialog
      ref={ref}
    >
      {open && (
        <div className="dialog-body">
          {brand && (
            <div className="dialog-brand">
              {brand}
              <IconButton data-action={closeActionId} icon="close" label={t("common.close")} onClick={onClose} size="small" />
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
