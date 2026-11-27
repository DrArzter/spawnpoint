import type { ControlPlaneSnapshot } from "../model";
import { configuredHosts } from "../session";

/*
 * The snapshot is read again while anything in it is on its way somewhere, so
 * the panel follows a change even when the socket's message never arrives.
 */

export const SETTLE_POLL_MS = 5000;
export const SETTLE_SLOW_POLL_MS = 15_000;
export const SETTLE_SLOW_AFTER_MS = 10 * 60 * 1000;

const MOVING_SESSION = new Set(["starting", "stopping", "moving"]);

/** Whether the snapshot shows anything still in transition. */
export function unsettled(snapshot: ControlPlaneSnapshot | null): boolean {
  if (snapshot === null) return false;
  if (snapshot.operations.length > 0) return true;
  if (configuredHosts(snapshot).some((host) => host.state === "pending" || host.state === "stopping")) return true;
  return snapshot.games.some((game) =>
    MOVING_SESSION.has(game.lifecycle?.observedState ?? "") ||
    game.worlds.some((world) => MOVING_SESSION.has(world.session?.observedState ?? "")) ||
    game.presets.some((preset) => preset.buildStatus === "building"));
}

/** How long to wait before the next read, by how long the snapshot has been unsettled. */
export function settlePollDelay(unsettledForMs: number): number {
  return unsettledForMs < SETTLE_SLOW_AFTER_MS ? SETTLE_POLL_MS : SETTLE_SLOW_POLL_MS;
}

export type SettlePoll = Readonly<{
  /** The page was shown again: wait a full delay, since showing reads once already. */
  show: () => void;
  hide: () => void;
  stop: () => void;
}>;

/** Reloads after each delay until stopped. No timer runs while hidden, and a reload waits for the one before it. */
export function startSettlePoll(options: Readonly<{ reload: () => Promise<void>; visible: () => boolean; now?: () => number }>): SettlePoll {
  const now = options.now ?? Date.now;
  const since = now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = () => {
    clearTimeout(timer);
    if (!stopped && options.visible()) timer = setTimeout(() => { void tick(); }, settlePollDelay(now() - since));
  };
  async function tick(): Promise<void> {
    if (stopped || !options.visible()) return;
    try {
      await options.reload();
    } catch {
      // The reload reports its own failure; the next tick tries again.
    }
    later();
  }
  later();
  return {
    show: later,
    hide: () => { clearTimeout(timer); },
    stop: () => { stopped = true; clearTimeout(timer); },
  };
}
