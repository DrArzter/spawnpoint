import test, { type TestContext } from "node:test";

import { ENABLED_SKIN_IDS, type SkinId } from "../../src/skins/skin.ts";

// A skin switched off keeps its code but no tests (ADR-0106). A test that
// belongs to one skin skips, with the reason, while that skin is off.

export function skinEnabled(skin: SkinId): boolean {
  return ENABLED_SKIN_IDS.includes(skin);
}

/** The reason a test of `skin` skips, or false while the skin is on. */
export function skinOff(skin: SkinId): string | false {
  return skinEnabled(skin) ? false : `the ${skin} skin is switched off (ADR-0106)`;
}

/** node:test's `test`, skipped while `skin` is switched off. */
export function skinTest(skin: SkinId): (name: string, fn: (context: TestContext) => void | Promise<void>) => void {
  const skip = skinOff(skin);
  return (name, fn) => { test(name, { skip }, fn); };
}
