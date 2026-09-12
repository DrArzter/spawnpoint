import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Icon } from "../../icons";
import { cx } from "../../lib/cx";
import { Button, IconButton } from "./Button";

export type SnackTone = "info" | "success" | "error";
export type SnackInput = { message: string; tone?: SnackTone; action?: { label: string; onClick: () => void }; persistent?: boolean };
type Snack = SnackInput & { id: number; tone: SnackTone };

const SnackbarContext = createContext<(snack: SnackInput) => void>(() => undefined);

export function useSnackbar(): (snack: SnackInput) => void {
  return useContext(SnackbarContext);
}

// Outcomes arrive at the bottom edge and leave on their own; errors stay
// until dismissed because they name a recovery.
export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Snack[]>([]);
  const counter = useRef(0);
  const dismiss = useCallback((id: number) => setQueue((current) => current.filter((snack) => snack.id !== id)), []);
  const notify = useCallback((input: SnackInput) => {
    counter.current += 1;
    setQueue((current) => [...current.slice(-2), { ...input, tone: input.tone ?? "info", id: counter.current }]);
  }, []);
  const value = useMemo(() => notify, [notify]);
  return (
    <SnackbarContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="snackbar-host" role="region" aria-label="Notifications">
        {queue.map((snack) => <SnackbarItem key={snack.id} onDismiss={() => dismiss(snack.id)} snack={snack} />)}
      </div>
    </SnackbarContext.Provider>
  );
}

function SnackbarItem({ snack, onDismiss }: { snack: Snack; onDismiss: () => void }) {
  useEffect(() => {
    if (snack.persistent || snack.tone === "error") return;
    const timer = window.setTimeout(onDismiss, 6000);
    return () => window.clearTimeout(timer);
  }, [snack, onDismiss]);
  return (
    <div className={cx("snackbar", `snackbar-${snack.tone}`)} role={snack.tone === "error" ? "alert" : "status"}>
      {snack.tone === "error" && <Icon name="error" size={20} />}
      {snack.tone === "success" && <Icon name="check_circle" size={20} />}
      <p>{snack.message}</p>
      {snack.action && <Button onClick={() => { snack.action?.onClick(); onDismiss(); }} size="small" variant="text">{snack.action.label}</Button>}
      <IconButton icon="close" label="Dismiss" onClick={onDismiss} size="small" />
    </div>
  );
}
