import { RELEASE_ITEM_STATES, type ReleaseItemState } from "./release-objects.ts";

// One answer to "may this release be used?" for create, wipe, restore and
// promotion (ADR-0080). A release the reference table does not know is legacy
// or not yet registered, and stays usable. A release being retired, or retired,
// is not offered again, even though its manifest still exists.

export type ReleaseUsability = "usable" | "release_retired" | "release_not_ready";

/** The state of a release item, or null when the table has no item for it. */
export type ReleaseStateReader = (gameId: string, presetId: string, release: string) => Promise<ReleaseItemState | null>;

/** For a control plane with no reference table (the local one): every release is unknown, so usable. */
export const noReleaseState: ReleaseStateReader = async () => null;

export function releaseUsability(state: ReleaseItemState | null): ReleaseUsability {
  if (state === null || state === "live") return "usable";
  return state === "building" ? "release_not_ready" : "release_retired";
}

/** Unknown states are refused: a reader that cannot name a state must not use the release. */
export function parseReleaseItemState(value: unknown): ReleaseItemState | "unknown" {
  return (RELEASE_ITEM_STATES as readonly unknown[]).includes(value) ? value as ReleaseItemState : "unknown";
}

export async function checkReleaseUsable(read: ReleaseStateReader, gameId: string, presetId: string, release: string): Promise<ReleaseUsability> {
  return releaseUsability(await read(gameId, presetId, release));
}

/** The same check for a caller that stops with an error code, as the world workflow does. */
export async function requireReleaseUsable(read: ReleaseStateReader, gameId: string, presetId: string, release: string): Promise<void> {
  const usability = await checkReleaseUsable(read, gameId, presetId, release);
  if (usability !== "usable") throw new Error(usability);
}
