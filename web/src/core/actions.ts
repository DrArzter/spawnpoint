import type { IconName } from "../icons";

/**
 * One thing a person can do, as the bones hand it to a skin. The skin draws
 * it however it likes; what it may not do is leave it out, change what it
 * says, or run it when it is disabled. `hint` is the reason it is disabled or
 * what running it will do, in a sentence the skin can show.
 */
export type Action = Readonly<{
  /** Stable across skins and sessions: `world.start`, `access.approve`. */
  id: string;
  label: string;
  run: () => void;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
  hint?: string;
  /** A second line under the label, where the skin has room for one. */
  detail?: string;
  /** A suggestion, not a requirement: a skin without icons ignores it. */
  icon?: IconName;
}>;

export function action(id: string, label: string, run: () => void, rest: Omit<Action, "id" | "label" | "run"> = {}): Action {
  return { id, label, run, ...rest };
}

export function isAction(value: unknown): value is Action {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.label === "string" && typeof candidate.run === "function";
}

/**
 * Every action reachable from a model, wherever it sits. This is what the
 * skin contract is measured against: a skin must render each of these.
 */
export function actionsOf(model: unknown, seen = new Set<unknown>()): Action[] {
  if (model === null || typeof model !== "object" || seen.has(model)) return [];
  seen.add(model);
  if (isAction(model)) return [model];
  const values = Array.isArray(model) ? model : Object.values(model as Record<string, unknown>);
  return values.flatMap((value) => actionsOf(value, seen));
}
