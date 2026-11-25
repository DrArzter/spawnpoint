import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Icon } from "../../icons";
import { cx } from "../../lib/cx";
import { Button, IconButton } from "./Button";
import { useLayer } from "./layer";
import { t } from "../../i18n";

export type SnackTone = "info" | "success" | "error";
export type SnackInput = { message: string; tone?: SnackTone; action?: { label: string; onClick: () => void }; persistent?: boolean };
export type Snack = SnackInput & { id: number; tone: SnackTone };
/** What a skin that draws its own notifications reads: the queue and the way to drop one. */
export type SnackbarQueue = Readonly<{ items: readonly Snack[]; dismiss: (id: number) => void }>;

const SnackbarContext = createContext<(snack: SnackInput) => void>(() => undefined);
const QueueContext = createContext<SnackbarQueue>({ items: [], dismiss: () => undefined });

/** How long an outcome stays before the queue drops it; an error or a persistent item stays until dismissed. */
export const SNACK_DWELL_MS = 6000;

/** The queue holds the newest three. */
export function enqueue(queue: readonly Snack[], input: SnackInput, id: number): Snack[] {
  return [...queue.slice(-2), { ...input, tone: input.tone ?? "info", id }];
}

export function dropSnack(queue: readonly Snack[], id: number): Snack[] {
  return queue.filter((snack) => snack.id !== id);
}

/** The queue, for a skin's own notification area. */
export function useSnackbarQueue(): SnackbarQueue {
  return useContext(QueueContext);
}

export function useSnackbar(): (snack: SnackInput) => void {
  return useContext(SnackbarContext);
}

// Outcomes arrive at the bottom edge and leave on their own; errors stay
// until dismissed because they name a recovery. A skin that draws the queue
// itself passes `render`, and the default host is not drawn.
export function SnackbarProvider({ children, render }: Readonly<{ children: ReactNode; render?: (queue: SnackbarQueue) => ReactNode }>) {
  const [queue, setQueue] = useState<Snack[]>([]);
  const counter = useRef(0);
  const host = useRef<HTMLElement>(null);
  // Open from the start, so the live region is never hidden when an item joins it.
  useLayer(host, true, true);
  const dismiss = useCallback((id: number) => setQueue((current) => dropSnack(current, id)), []);
  const notify = useCallback((input: SnackInput) => {
    counter.current += 1;
    const id = counter.current;
    setQueue((current) => enqueue(current, input, id));
  }, []);
  const value = useMemo(() => notify, [notify]);
  const shared = useMemo<SnackbarQueue>(() => ({ items: queue, dismiss }), [queue, dismiss]);
  return (
    <SnackbarContext.Provider value={value}>
      <QueueContext.Provider value={shared}>
        {children}
        {render ? render(shared) : (
          <section aria-label={t("common.notifications")} aria-live="polite" className="snackbar-host" data-layer="toast" popover="manual" ref={host}>
            {queue.map((snack) => <SnackbarItem key={snack.id} onDismiss={() => dismiss(snack.id)} snack={snack} />)}
          </section>
        )}
        {render && queue.map((snack) => <SnackTimer key={snack.id} onDismiss={() => dismiss(snack.id)} snack={snack} />)}
      </QueueContext.Provider>
    </SnackbarContext.Provider>
  );
}

function useDwell(snack: Snack, onDismiss: () => void) {
  useEffect(() => {
    if (snack.persistent || snack.tone === "error") return;
    const timer = window.setTimeout(onDismiss, SNACK_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [snack, onDismiss]);
}

// The queue keeps its own time when a skin draws it, so no skin keeps a timer for it.
function SnackTimer({ snack, onDismiss }: Readonly<{ snack: Snack; onDismiss: () => void }>) {
  useDwell(snack, onDismiss);
  return null;
}

function SnackbarItem({ snack, onDismiss }: Readonly<{ snack: Snack; onDismiss: () => void }>) {
  useDwell(snack, onDismiss);
  // An error interrupts (alert); anything else is polite, which <output> is.
  const Live = snack.tone === "error" ? "div" : "output";
  return (
    <Live className={cx("snackbar", `snackbar-${snack.tone}`)} role={snack.tone === "error" ? "alert" : undefined}>
      {snack.tone === "error" && <Icon name="error" size={20} />}
      {snack.tone === "success" && <Icon name="check_circle" size={20} />}
      <p>{snack.message}</p>
      {snack.action && <Button onClick={() => { snack.action?.onClick(); onDismiss(); }} size="small" variant="text">{snack.action.label}</Button>}
      <IconButton icon="close" label={t("common.dismiss")} onClick={onDismiss} size="small" />
    </Live>
  );
}
