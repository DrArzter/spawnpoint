import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Dependency direction in the Lambdas. Business code depends on ports; only
// adapters and Lambda entries touch the AWS SDK. LEGACY_SDK_IMPORTERS records
// the code that still calls AWS directly. It may only get shorter.

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

// An adapter says what it adapts in its file name.
const ADAPTER = /(?:^|\/)(?:aws|aws-[a-z-]+|s3-[a-z-]+|dynamo-[a-z-]+|ses-[a-z-]+|[a-z-]+-store|[a-z-]+-port)\.ts$/;

const LEGACY_SDK_IMPORTERS: readonly string[] = [
  "access/account-writes.ts",
  "access/identity-creation.ts",
  "bot/notifier.ts",
  "bot/services/access.ts",
  "bot/services/subscribers.ts",
  "builder/release-writer-main.ts",
  "control-plane/dns-ledger.ts",
  "control-plane/release-refs.ts",
  "handlers/api/access-invitations.ts",
  "handlers/api/access.ts",
  "handlers/api/avatars.ts",
  "handlers/api/backups.ts",
  "handlers/api/clients.ts",
  "handlers/api/control-plane.ts",
  "handlers/api/credentials.ts",
  "handlers/api/email-actions.ts",
  "handlers/api/identity-deletion.ts",
  "handlers/api/invitations.ts",
  "handlers/api/linked-accounts.ts",
  "handlers/api/login-sessions.ts",
  "handlers/api/mail.ts",
  "handlers/api/oauth.ts",
  "handlers/api/passwords.ts",
  "handlers/api/profile.ts",
  "handlers/api/secrets.ts",
  "handlers/api/session.ts",
  "handlers/backup-retention.ts",
  "handlers/control-plane-projector.ts",
  "handlers/control-plane-subscriptions.ts",
  "handlers/fleet-sweeper.ts",
  "handlers/lifecycle-coordinator.ts",
  "handlers/release-reconciler.ts",
  "handlers/release-retirement.ts",
  "handlers/release-state.ts",
  "handlers/world-lifecycle.ts",
];

type Source = Readonly<{ path: string; packages: readonly string[]; local: readonly string[] }>;

const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

async function sources(): Promise<readonly Source[]> {
  const entries = await readdir(SOURCE, { recursive: true });
  const files = entries.filter((name) => name.endsWith(".ts")).map((name) => name.split("\\").join("/")).sort();
  return Promise.all(files.map(async (path) => {
    const text = await readFile(join(SOURCE, path), "utf8");
    const specifiers = [...text.matchAll(SPECIFIER)].map((match) => match[1] ?? "");
    const local = specifiers
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => relative(SOURCE, resolve(SOURCE, dirname(path), specifier)).split("\\").join("/"));
    return { path, packages: specifiers.filter((specifier) => !specifier.startsWith(".")), local };
  }));
}

test("only adapters and the recorded legacy files import the AWS SDK", async () => {
  const importers = (await sources()).filter((source) => source.packages.some((name) => name.startsWith("@aws-sdk/")));
  for (const { path } of importers) {
    assert.ok(ADAPTER.test(path) || LEGACY_SDK_IMPORTERS.includes(path),
      `${path} imports the AWS SDK: put the call behind a port in an adapter file (aws-*, s3-*, dynamo-*, ses-*, *-store, *-port)`);
  }
  const still = new Set(importers.map((source) => source.path));
  for (const path of LEGACY_SDK_IMPORTERS) {
    assert.ok(still.has(path), `${path} no longer imports the AWS SDK: remove it from LEGACY_SDK_IMPORTERS`);
  }
});

test("the domain imports nothing but the domain and the shared contract", async () => {
  for (const source of (await sources()).filter(({ path }) => path.startsWith("domain/"))) {
    for (const name of source.packages) {
      assert.match(name, /^node:/, `${source.path} imports ${name}: the domain depends on no package`);
    }
    for (const target of source.local) {
      assert.ok(target.startsWith("domain/") || target.startsWith("../contract/"), `${source.path} imports ${target}`);
    }
  }
});

test("nothing outside the handlers imports a handler", async () => {
  for (const source of (await sources()).filter(({ path }) => !path.startsWith("handlers/"))) {
    for (const target of source.local) {
      assert.ok(!target.startsWith("handlers/"), `${source.path} imports ${target}: handlers sit at the edge`);
    }
  }
});

test("the Lambda sources have no import cycle", async () => {
  const all = await sources();
  const edges = new Map(all.map((source) => [source.path, source.local.filter((target) => target.endsWith(".ts"))]));
  const state = new Map<string, "open" | "done">();
  const trail: string[] = [];
  const visit = (path: string): void => {
    if (state.get(path) === "done" || !edges.has(path)) return;
    assert.notEqual(state.get(path), "open", `import cycle: ${[...trail.slice(trail.indexOf(path)), path].join(" -> ")}`);
    state.set(path, "open");
    trail.push(path);
    for (const target of edges.get(path) ?? []) visit(target);
    trail.pop();
    state.set(path, "done");
  };
  for (const path of edges.keys()) visit(path);
});
