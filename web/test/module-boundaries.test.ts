import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The web keeps one composition root. Code receives the API through a context
// (api/context.tsx) and never reaches for the module that picks the adapter.
// The import graph has no cycle, type-only imports included.

const src = fileURLToPath(new URL("../src/", import.meta.url));

/** The only files that may import auth.ts, which builds the chosen API once. */
const AUTH_IMPORTERS: readonly string[] = ["main.tsx"];

function sourceFiles(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function resolveImport(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      if (statSync(candidate).isFile() && /\.tsx?$/.test(candidate)) return candidate;
    } catch { /* not this candidate */ }
  }
  return null;
}

// Every relative import: `import type`, re-exports and dynamic imports included.
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of source.matchAll(/\b(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g)) {
    const target = resolveImport(file, match[1] ?? "");
    if (target !== null) found.push(target);
  }
  return found;
}

const files = sourceFiles(src);
const graph = new Map(files.map((file) => [file, importsOf(file)]));
const name = (file: string) => relative(src, file);

// Tarjan's strongly connected components: a component of two or more files, or a file that imports itself, is a cycle.
function cycles(): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  let counter = 0;
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const group: string[] = [];
    for (let member = stack.pop()!; ; member = stack.pop()!) {
      onStack.delete(member);
      group.push(member);
      if (member === node) break;
    }
    if (group.length > 1 || (graph.get(node) ?? []).includes(node)) found.push(group.map(name).sort());
  };
  for (const file of graph.keys()) if (!index.has(file)) visit(file);
  return found;
}

test("the import graph under src has no cycle", () => {
  assert.ok(files.length > 100);
  assert.deepEqual(cycles(), []);
});

test("only the composition root imports auth", () => {
  const auth = join(src, "auth.ts");
  const importers = files.filter((file) => (graph.get(file) ?? []).includes(auth)).map(name).sort();
  assert.deepEqual(importers, [...AUTH_IMPORTERS]);
});

test("core, skins, screens and demo never import auth", () => {
  const auth = join(src, "auth.ts");
  for (const folder of ["core", "skins", "screens", "demo"]) {
    for (const file of files.filter((candidate) => candidate.startsWith(join(src, folder, "")))) {
      assert.ok(!(graph.get(file) ?? []).includes(auth), `${name(file)} imports auth: take the API from useApi() or a parameter`);
    }
  }
});
