import { access, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// Source files import each other without extensions, the way Vite resolves
// them. Node does not, so a relative specifier that names no file on disk is
// tried with the extensions the source uses, and as a folder's index.
const CANDIDATES = [".ts", ".tsx", ".json", "/index.ts", "/index.tsx"];

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

export async function resolve(specifier, context, next) {
  if (!specifier.startsWith(".") || /\.[a-z]+$/i.test(specifier) || context.parentURL === undefined) return next(specifier, context);
  const base = fileURLToPath(new URL(specifier, context.parentURL));
  for (const candidate of CANDIDATES) {
    if (await exists(base + candidate)) return { url: pathToFileURL(base + candidate).href, shortCircuit: true };
  }
  return next(specifier, context);
}

let transformWithOxc = null;

export async function load(url, context, next) {
  if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
  if (url.endsWith(".json") && url.startsWith("file:")) {
    const json = await readFile(fileURLToPath(url), "utf8");
    return { format: "module", source: `export default ${json};`, shortCircuit: true };
  }
  // Plain .ts goes through the same transformer: Node's own type stripping
  // keeps an import of a type that was written without `import type`, and
  // the panel's source has a few.
  if (!(url.endsWith(".tsx") || url.endsWith(".ts")) || !url.startsWith("file:") || url.includes("/node_modules/")) return next(url, context);
  const filename = fileURLToPath(url);
  const code = await readFile(filename, "utf8");
  transformWithOxc ??= (await import("vite")).transformWithOxc;
  const result = await transformWithOxc(code, filename, { jsx: { runtime: "automatic" } });
  // Vite fills import.meta.env at build time; here the panel reads an empty one.
  return { format: "module", source: `import.meta.env ??= {};\n${result.code}`, shortCircuit: true };
}
