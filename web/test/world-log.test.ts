import assert from "node:assert/strict";
import test from "node:test";

import { ASSISTANT_CHOICES, logLineTone } from "../src/core/data.ts";

// A world's log (ADR-0094): how a game's line reads, and the models offered.

test("a game's line is an error or a warning by the words games use", () => {
  assert.equal(logLineTone("[12:00:01] [Server thread/ERROR]: boom"), "error");
  assert.equal(logLineTone("java.lang.NullPointerException: x"), "error");
  assert.equal(logLineTone("[Server thread/FATAL] crash"), "error");
  assert.equal(logLineTone("[12:00:01] [Server thread/WARN]: Can't keep up!"), "warning");
  assert.equal(logLineTone("WARNING: low memory"), "warning");
  assert.equal(logLineTone("player-1 joined the game"), "plain");
  assert.equal(logLineTone("Errors: 0, warnings ignored"), "plain", "a word that only contains one is not one");
});

test("the Owner chooses between the two models, each with its meaning", () => {
  assert.deepEqual(ASSISTANT_CHOICES.map((choice) => choice.value), ["haiku", "sonnet"]);
  assert.ok(ASSISTANT_CHOICES.every((choice) => choice.hint.length > 0));
});
