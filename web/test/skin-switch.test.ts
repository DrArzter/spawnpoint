import "./support/browser.ts";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { currentSkinId, SKIN_CHOICES, SKINS } from "../src/skins/index.ts";
import { CHOOSABLE_SKIN_IDS, DEFAULT_SKIN, ENABLED_SKIN_IDS, enabledSkins, SKIN_IDS } from "../src/skins/skin.ts";

// A skin can be switched off (ADR-0106): its code stays, but it is never worn,
// offered or tested.

const location = window.location as { search: string };

function visit(search: string, stored: string | null): string {
  location.search = search;
  if (stored === null) window.localStorage.removeItem("spawnpoint.skin");
  else window.localStorage.setItem("spawnpoint.skin", stored);
  try {
    return currentSkinId();
  } finally {
    location.search = "";
  }
}

test("the default skin is switched on, and every switched-on skin is a known one", () => {
  assert.ok(ENABLED_SKIN_IDS.includes(DEFAULT_SKIN));
  for (const id of ENABLED_SKIN_IDS) assert.ok(SKIN_IDS.includes(id), id);
});

test("the terminal skin is switched off; the console is the one face", () => {
  assert.deepEqual(ENABLED_SKIN_IDS, ["console"]);
  assert.deepEqual(SKINS.map((skin) => skin.id), ["console"]);
  assert.deepEqual(CHOOSABLE_SKIN_IDS, ENABLED_SKIN_IDS);
  assert.deepEqual(SKIN_CHOICES.map((choice) => choice.id), ["console"]);
});

test("a stored or asked-for skin that is switched off falls back to the default and is not stored", () => {
  assert.equal(visit("", "terminal"), DEFAULT_SKIN);
  assert.equal(window.localStorage.getItem("spawnpoint.skin"), "terminal", "an old choice is left alone, only ignored");
  assert.equal(visit("?skin=terminal", null), DEFAULT_SKIN);
  assert.equal(window.localStorage.getItem("spawnpoint.skin"), null, "a switched-off skin asked for is not remembered");
  assert.equal(visit("?skin=nonsense", null), DEFAULT_SKIN);
  assert.equal(visit("?skin=console", "terminal"), "console");
  window.localStorage.removeItem("spawnpoint.skin");
});

test("a build-time list is checked: known names only, and the default among them", () => {
  assert.deepEqual(enabledSkins("terminal, console"), ["console", "terminal"]);
  assert.deepEqual(enabledSkins(" "), ENABLED_SKIN_IDS);
  assert.throws(() => enabledSkins("terminal"), /default skin "console" must be enabled/);
  assert.throws(() => enabledSkins("console,neon"), /Unknown skin "neon"/);
});

test("index.html stamps only a skin the build switched on", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /const enabled = __ENABLED_SKINS__;/);
  assert.match(html, /enabled\.includes\(chosen\) \? chosen : "console"/);
});
