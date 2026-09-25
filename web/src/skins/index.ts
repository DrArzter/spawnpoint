import { consoleSkin } from "./console";
import { DEFAULT_SKIN, SKIN_IDS, type Skin, type SkinId } from "./skin";
import { terminalSkin } from "./terminal";

export type { Skin, SkinId } from "./skin";

const skins: Readonly<Record<SkinId, Skin>> = { console: consoleSkin, terminal: terminalSkin };

/** Every face, for the chooser on the profile page. */
export const SKIN_CHOICES: readonly Readonly<{ id: SkinId; name: string }>[] = SKIN_IDS.map((id) => ({ id, name: skins[id].name }));

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
  return skins[currentSkinId()];
}

export function currentSkinId(): SkinId {
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
  return id;
}

/**
 * Wear another face from now on. The skin is chosen once, when the app
 * mounts, so the choice reloads the page rather than swapping views under
 * whatever is open; the address loses any `?skin=` that would override it.
 */
export function wearSkin(id: SkinId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Without storage the choice lasts one visit, which the address carries.
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("skin");
  window.location.replace(url.toString());
  window.location.reload();
}
