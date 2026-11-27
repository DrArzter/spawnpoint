import type { ControlPlaneSnapshot } from "../model";
import { configuredHosts } from "../session";

/*
 * The snapshot is read again while anything in it is on its way somewhere, so
 * the panel follows a change even when the socket's message never arrives. The
 * tables send that message from their own change streams (ADR-0104), so this
 * poll is only the safety net for a lost one, and reads at a safety net's pace.
 */

export const SETTLE_POLL_MS = 30_000;
/** After this long the poll ends; the socket and the reload on show take over (a stuck state does not poll for ever). */
export const SETTLE_GIVE_UP_AFTER_MS = 30 * 60 * 1000;
/** How long an accepted request keeps the poll alive while its operation is not yet in the snapshot. */
export const SETTLE_EXPECT_MS = 60_000;
/** A show or online event this soon after a load makes no read of its own. */
export const SHOW_RELOAD_GAP_MS = 2000;

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

/** How long to wait before the next read, by how long the snapshot has been unsettled; null ends the poll. */
export function settlePollDelay(unsettledForMs: number): number | null {
  return unsettledForMs >= SETTLE_GIVE_UP_AFTER_MS ? null : SETTLE_POLL_MS;
}

/**
 * What is in transition now, as a string: empty when nothing is. The poll
 * starts again, with a fresh cap, whenever it changes, so a new start or stop
 * is followed even after a stuck one used up its 30 minutes.
 */
export function settleSignature(snapshot: ControlPlaneSnapshot | null, expectingUntil: number, now: number): string {
  const parts: string[] = [];
  if (expectingUntil > now) parts.push(`request:${expectingUntil}`);
  if (snapshot === null) return parts.join("|");
  for (const operation of snapshot.operations) parts.push(`operation:${operation.id}`);
  for (const host of configuredHosts(snapshot)) if (host.state === "pending" || host.state === "stopping") parts.push(`host:${host.id}:${host.state}`);
  for (const game of snapshot.games) {
    const observed = game.lifecycle?.observedState ?? "";
    if (MOVING_SESSION.has(observed)) parts.push(`game:${game.id}:${observed}`);
    for (const world of game.worlds) {
      const state = world.session?.observedState ?? "";
      if (MOVING_SESSION.has(state)) parts.push(`world:${world.id}:${state}`);
    }
    for (const preset of game.presets) if (preset.buildStatus === "building") parts.push(`build:${game.id}:${preset.id}`);
  }
  return parts.join("|");
}

/** Whether the poll should run: the snapshot is in transition, or a request was accepted and its operation is not listed yet. */
export function settleWanted(snapshot: ControlPlaneSnapshot | null, expectingUntil: number, now: number): boolean {
  return settleSignature(snapshot, expectingUntil, now) !== "";
}

/** Whether showing the tab or coming back online owes a read: not when one began a moment ago. */
export function owesShowReload(lastLoadStartedAt: number, now: number): boolean {
  return now - lastLoadStartedAt >= SHOW_RELOAD_GAP_MS;
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
    const delay = settlePollDelay(now() - since);
    if (delay === null) stopped = true;
    if (!stopped && options.visible()) timer = setTimeout(() => { void tick(); }, delay!);
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
