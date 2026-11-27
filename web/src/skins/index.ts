import { consoleSkin } from "./console";
import { CHOOSABLE_SKIN_IDS, DEFAULT_SKIN, ENABLED_SKIN_IDS, type Skin, type SkinId } from "./skin";
import { terminalSkin } from "./terminal";

export type { Skin, SkinId } from "./skin";

const skins: Readonly<Record<SkinId, Skin>> = { console: consoleSkin, terminal: terminalSkin };

/** Every face switched on, each held to the skin contract; a face switched off is not tested. */
export const SKINS: readonly Skin[] = ENABLED_SKIN_IDS.map((id) => skins[id]);
/** The faces offered on the profile page. */
export const SKIN_CHOICES: readonly Readonly<{ id: SkinId; name: string }>[] = CHOOSABLE_SKIN_IDS.map((id) => ({ id, name: skins[id].name }));

/** A face that is switched on; a stored or asked-for face that is off reads as no choice. */
export function isEnabledSkin(value: unknown): value is SkinId {
  return typeof value === "string" && (ENABLED_SKIN_IDS as readonly string[]).includes(value);
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
    if (isEnabledSkin(stored)) id = stored;
    const requested = new URLSearchParams(window.location.search).get("skin");
    if (isEnabledSkin(requested)) {
      id = requested;
      window.localStorage.setItem(STORAGE_KEY, requested);
    }
  } catch {
    // Storage may be unavailable in a restricted embedded browser; the default serves.
  }
  return id;
}

/**
 * Stamp the document with the face the console surfaces wear, or take it
 * off for the front door, which never wears one. index.html stamps the
 * remembered face before the first paint, so on a console route this only
 * confirms it; on the front door it undoes it.
 */
export function wearOnDocument(id: SkinId, worn: boolean): void {
  const root = document.documentElement;
  if (worn) root.dataset.skin = id;
  else delete root.dataset.skin;
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
