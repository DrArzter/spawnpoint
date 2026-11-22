import assert from "node:assert/strict";
import test from "node:test";

import { confirmationCopy } from "../src/core/forms.ts";
import type { Confirmation } from "../src/shell/actions.ts";

const restore = (release: string | null): Confirmation => ({
  kind: "restore", game: {} as never, world: {} as never, backupKey: "worlds/w/archives/a.tar.zst", backupName: "a.tar.zst", release,
});

test("the restore dialog names the release the backup runs on", () => {
  const copy = confirmationCopy(restore("4.9"));
  assert.match(copy.description, /on release 4\.9, the release it ran\./);
  assert.equal(copy.destructive, true);
});

test("a backup whose release cannot be read restores without naming one", () => {
  assert.doesNotMatch(confirmationCopy(restore(null)).description, /release/);
});
