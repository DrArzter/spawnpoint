import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { action } from "../src/core/actions.ts";
import { gameProofNote, offeredGames } from "../src/core/game-proof.ts";
import type { ScopeModel } from "../src/core/models.ts";
import { ScopeDialog, ScopeSwitcher } from "../src/skins/console/Scope.tsx";
import { Indicator } from "../src/skins/console/ui/Indicator.tsx";
import { aGame } from "./support/fixtures.ts";

// ADR-0109: a game that has not run here is the Owner's to try, and marked for the Owner.

const proven = aGame();
const untried = aGame({ id: "zomboid", code: "PZ", displayName: "Project Zomboid", proven: false });

test("an Owner is offered every game; any other role only those that have run here", () => {
  assert.deepEqual(offeredGames([proven, untried], new Set(["access.owner.grant"])).map((game) => game.id), ["minecraft", "zomboid"]);
  assert.deepEqual(offeredGames([proven, untried], new Set(["world.manage", "session.start"])).map((game) => game.id), ["minecraft"]);
  assert.equal(gameProofNote(proven), null);
  assert.ok(gameProofNote(untried));
});

test("an Indicator inside a control takes no tab stop of its own and keeps its name and tooltip", () => {
  const html = renderToStaticMarkup(createElement(Indicator, { icon: "help", label: "Not yet", inControl: true }));
  assert.doesNotMatch(html, /tabindex/);
  assert.match(html, /aria-label="Not yet"[^>]*data-tip="Not yet"[^>]*role="img"/);
  assert.match(renderToStaticMarkup(createElement(Indicator, { icon: "help", label: "Not yet" })), /tabindex="0"/);
});

test("the game picker marks an untried game in both of its forms, and only that game", () => {
  const model: ScopeModel = {
    game: proven, games: [proven, untried], statusOf: () => ({ kind: "off", label: "Stopped" }), noteOf: gameProofNote,
    open: true, show: action("scope.show", "Minecraft", () => undefined), close: action("scope.close", "Cancel", () => undefined), select: () => undefined,
  };
  const note = gameProofNote(untried) as string;
  for (const html of [renderToStaticMarkup(createElement(ScopeDialog, { model })), renderToStaticMarkup(createElement(ScopeSwitcher, { model }))]) {
    assert.equal(html.split(`data-tip="${note}"`).length - 1, 1, "one mark, on the untried game");
    assert.doesNotMatch(html, /<button[^>]*>(?:(?!<\/button>).)*tabindex="0"(?:(?!<\/button>).)*<\/button>/s, "no tab stop inside a game's button");
  }
  assert.match(renderToStaticMarkup(createElement(ScopeSwitcher, { model })), new RegExp(`aria-label="Project Zomboid, Stopped, ${note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
});
