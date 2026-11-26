import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useLayer } from "../../../components/ui/layer";
import { Icon } from "../../../icons";
import { cx } from "../../../lib/cx";
import { holdHeight, useLeaving } from "./leaving";
import { MOTION } from "./motion";

export type ToastKind = "why" | "err" | "info";
type Toast = Readonly<{ id: number; kind: ToastKind; message: string }>;

const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => undefined);

/** Shows a short line at the bottom centre: a refusal reason or an outcome that needs no flashbar. */
export function useToast(): (message: string, kind?: ToastKind) => void {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const host = useRef<HTMLDivElement>(null);
  // Open from the start, so the live region is never hidden when a toast joins it.
  useLayer(host, true, true);
  const show = useCallback((message: string, kind: ToastKind = "info") => {
    counter.current += 1;
    const id = counter.current;
    setToasts((current) => [...current.filter((item) => item.message !== message).slice(-2), { id, kind, message }]);
  }, []);
  const value = useMemo(() => show, [show]);
  const stack = useLeaving(toasts, (toast) => String(toast.id));
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="c-toasts" data-layer="toast" popover="manual" ref={host} role="status">
        {stack.map(({ item: toast, leaving }) => <ToastItem key={toast.id} leaving={leaving} onDone={() => setToasts((current) => current.filter((item) => item.id !== toast.id))} toast={toast} />)}
      </div>
    </ToastContext.Provider>
  );
}

const toastIcons = { why: "lock", err: "error", info: "info" } as const;

function ToastItem({ toast, leaving, onDone }: Readonly<{ toast: Toast; leaving: boolean; onDone: () => void }>) {
  useEffect(() => {
    if (leaving) return;
    const timer = window.setTimeout(onDone, MOTION["--c-dwell-toast"]);
    return () => window.clearTimeout(timer);
  }, [leaving, onDone]);
  return (
    <div aria-hidden={leaving || undefined} className={cx("c-toast", `c-toast-${toast.kind}`, leaving && "c-leaving")} ref={leaving ? holdHeight : undefined}>
      <Icon name={toastIcons[toast.kind]} size={18} />
      <span>{toast.message}</span>
    </div>
  );
}
