import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Dependency direction in the Lambdas. Business code depends on ports; only
// adapters send to AWS. A Lambda entry is its composition root: it may build
// the SDK's clients and hand them to adapters, and it sends nothing itself.

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

// An adapter says what it adapts in its file name.
const ADAPTER = /(?:^|\/)(?:aws|aws-[a-z-]+|s3-[a-z-]+|ssm-[a-z-]+|dynamo-[a-z-]+|ses-[a-z-]+|[a-z-]+-store|[a-z-]+-port)\.ts$/;

// A Lambda's entry: the API and worker handlers, the bot's two, the release writer.
const ENTRY = /^(?:handlers\/[a-z-]+|bot\/(?:handler|notifier)|builder\/[a-z-]+-main)\.ts$/;

// What an entry may take from the SDK: a client to construct, or a type.
const CLIENT_ONLY = /^(?:type\s+)?[A-Za-z0-9]+Client$/;

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

test("only adapters send to the AWS SDK; an entry only builds its clients", async () => {
  for (const source of await sources()) {
    if (!source.packages.some((name) => name.startsWith("@aws-sdk/")) || ADAPTER.test(source.path)) continue;
    assert.ok(ENTRY.test(source.path),
      `${source.path} imports the AWS SDK: put the call behind a port in an adapter file (aws-*, s3-*, ssm-*, dynamo-*, ses-*, *-store, *-port)`);
    const text = await readFile(join(SOURCE, source.path), "utf8");
    for (const [, names = "", from = ""] of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(@aws-sdk\/[^"]+)"/g)) {
      for (const name of names.split(",").map((item) => item.trim()).filter(Boolean)) {
        assert.match(name, CLIENT_ONLY, `${source.path} takes ${name} from ${from}: an entry builds clients; an adapter sends commands`);
      }
    }
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
