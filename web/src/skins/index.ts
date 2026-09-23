import { consoleSkin } from "./console";
import { DEFAULT_SKIN, SKIN_IDS, type Skin, type SkinId } from "./skin";

export type { Skin, SkinId } from "./skin";

const skins: Readonly<Record<SkinId, Skin>> = { console: consoleSkin };

export function isSkinId(value: unknown): value is SkinId {
  return typeof value === "string" && (SKIN_IDS as readonly string[]).includes(value);
}

const STORAGE_KEY = "spawnpoint.skin";

/**
 * Which face the console wears. `?skin=` in the address wins for that visit
 * and is remembered, so a skin can be tried from a link; otherwise the last
 * remembered choice, otherwise the default. Stored beside theme and accent;
 * the account copy follows when a second skin ships.
 */
export function chooseSkin(): Skin {
  let id: SkinId = DEFAULT_SKIN;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isSkinId(stored)) id = stored;
    const requested = new URLSearchParams(window.location.search).get("skin");
    if (isSkinId(requested)) {
      id = requested;
      window.localStorage.setItem(STORAGE_KEY, requested);
    }
  } catch {
    // Storage may be unavailable in a restricted embedded browser; the default serves.
  }
  return skins[id];
}
