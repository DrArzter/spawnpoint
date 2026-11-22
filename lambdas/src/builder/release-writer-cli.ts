import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { ReleaseRefsError, type ReleaseRef, type ReleaseRefs } from "../control-plane/release-refs.ts";
import type { ManifestPack } from "../control-plane/release-objects.ts";
import { holdCatalog, publishRelease, withObjectLayout, writeObjects, WriterError, type Manifest, type ObjectPort, type WriteResult } from "./object-writer.ts";

// The command line of the objects-v1 writer. Bash runs it from
// upload-release.sh and the catalog builders and reads `key=value` lines, as it
// does for the other builder scripts. The SDK clients come from the caller, so
// a test runs the whole command with an in-memory port and table.
//
//   write         --manifest f --source-dir d --game g --preset p --release r --build-id id
//                 [--pack client=f --pack server=f --pack full=f] [--upstream-map f] [--profile-digest d] [--heal]
//   publish       --game g --preset p --release r --build-id id
//   hold-catalog  --game g --preset p --releases 1.1,1.2

export type CliDeps = Readonly<{ port: ObjectPort; refs: ReleaseRefs }>;
export type CliSettings = Readonly<{ bucket: string; table: string | undefined }>;
export type CliIo = Readonly<{ out: (line: string) => void; err: (line: string) => void }>;

const GAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RELEASE = /^\d+\.\d+$/;

function usage(detail: string): never {
  throw new WriterError("invalid_arguments", detail);
}

/** A path from the command line: absolute, and never with a `..` segment, so it cannot climb out of the directory it names. */
// The builder hands the writer paths from mktemp and its workspace; RELEASE_WRITER_ROOT adds one more root.
function allowedRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = [tmpdir(), "/tmp", process.cwd()];
  if (env.RELEASE_WRITER_ROOT) roots.push(env.RELEASE_WRITER_ROOT);
  return [...new Set(roots.map((root) => resolve(root)))];
}

function safePath(value: string, what: string, env: NodeJS.ProcessEnv): string {
  if (value === "" || value.includes("\0") || value.split(/[\\/]/).includes("..")) usage(what);
  const resolved = resolve(value);
  if (!allowedRoots(env).some((root) => resolved === root || resolved.startsWith(root + sep))) usage(what);
  return resolved;
}

function releaseRef(values: Record<string, unknown>): ReleaseRef {
  const { game, preset, release } = values as Record<string, string | undefined>;
  if (game === undefined || !GAME.test(game)) usage("game");
  if (preset === undefined || !GAME.test(preset)) usage("preset");
  if (release === undefined || !RELEASE.test(release)) usage("release");
  return { gameId: game, presetId: preset, release };
}

function buildId(values: Record<string, unknown>): string {
  const id = values["build-id"];
  if (typeof id !== "string" || id.length === 0 || id.length > 200 || /[\s#]/.test(id)) usage("build-id");
  return id;
}

function concurrency(env: NodeJS.ProcessEnv): number {
  const raw = env.RELEASE_UPLOAD_CONCURRENCY ?? "16";
  if (!/^[1-9]\d?$/.test(raw)) usage("RELEASE_UPLOAD_CONCURRENCY must be 1 to 99");
  return Number(raw);
}

function packFiles(values: readonly string[], env: NodeJS.ProcessEnv): Partial<Record<ManifestPack, string>> {
  const packs: Partial<Record<ManifestPack, string>> = {};
  for (const value of values) {
    const [name, ...rest] = value.split("=");
    const path = rest.join("=");
    if ((name !== "client" && name !== "server" && name !== "full") || path === "" || packs[name] !== undefined) usage("pack");
    packs[name] = safePath(path, "pack", env);
  }
  return packs;
}

async function upstreamMap(path: string | undefined): Promise<Map<string, string>> {
  if (path === undefined) return new Map();
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown; // NOSONAR path checked by safePath: no parent segment, inside an allowed root
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) usage("upstream-map");
  return new Map(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function replaceFile(path: string, content: string): Promise<void> {
  const staged = `${path}.writer`;
  await writeFile(staged, content); // NOSONAR path checked by safePath: no parent segment, inside an allowed root
  await rename(staged, path); // NOSONAR path checked by safePath: no parent segment, inside an allowed root
}

async function write(argv: readonly string[], env: NodeJS.ProcessEnv, deps: CliDeps, io: CliIo): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      manifest: { type: "string" }, "source-dir": { type: "string" }, game: { type: "string" }, preset: { type: "string" }, release: { type: "string" },
      "build-id": { type: "string" }, pack: { type: "string", multiple: true }, "upstream-map": { type: "string" }, "profile-digest": { type: "string" }, heal: { type: "boolean" },
    },
  });
  if (values.manifest === undefined || values["source-dir"] === undefined) usage("manifest and source-dir");
  const manifestPath = safePath(values.manifest, "manifest", env);
  const sourceDir = safePath(values["source-dir"], "source-dir", env);
  const packs = packFiles(values.pack ?? [], env);
  const upstreamPath = values["upstream-map"] === undefined ? undefined : safePath(values["upstream-map"], "upstream-map", env);
  const ref = releaseRef(values);
  const id = buildId(values);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest; // NOSONAR path checked by safePath: no parent segment, inside an allowed root
  const heal = values.heal === true;
  const started = Date.now();
  const result = await writeObjects(deps, {
    ref, buildId: id, sourceDir, manifest, packs,
    concurrency: concurrency(env), upstream: await upstreamMap(upstreamPath), heal,
    ...(values["profile-digest"] === undefined ? {} : { profileDigest: values["profile-digest"] }),
    progressEvery: Number(env.RELEASE_UPLOAD_PROGRESS_EVERY ?? "100") || 100, log: io.err,
  });
  // Written only after every object is in place: a failed run leaves the manifest as it was.
  if (!heal) await replaceFile(manifestPath, `${JSON.stringify(withObjectLayout(manifest, result.packs), null, 2)}\n`);
  for (const line of resultLines(result, Math.round((Date.now() - started) / 1000))) io.out(line);
}

function resultLines(result: WriteResult, seconds: number): string[] {
  return [
    "layout=objects-v1", `objects_total=${result.total}`, `objects_created=${result.created}`, `objects_reused=${result.reused}`,
    `objects_recreated=${result.recreated}`, `objects_repaired=${result.repaired}`, `objects_copied=${result.copied}`, `bytes_uploaded=${result.bytesUploaded}`,
    // Measurement hook: the writer's wall time, for docs/measurements.md.
    `writer_seconds=${seconds}`,
  ];
}

async function publish(argv: readonly string[], deps: CliDeps, io: CliIo): Promise<void> {
  const { values } = parseArgs({ args: [...argv], options: { game: { type: "string" }, preset: { type: "string" }, release: { type: "string" }, "build-id": { type: "string" } } });
  await publishRelease(deps.refs, releaseRef(values), buildId(values));
  io.out("release_state=live");
}

async function holdCatalogCommand(argv: readonly string[], deps: CliDeps, io: CliIo): Promise<void> {
  const { values } = parseArgs({ args: [...argv], options: { game: { type: "string" }, preset: { type: "string" }, releases: { type: "string" } } });
  const ref = releaseRef({ ...values, release: "0.0" });
  const releases = (values.releases ?? "").split(",").filter((release) => release !== "");
  if (!releases.every((release) => RELEASE.test(release))) usage("releases");
  await holdCatalog(deps.refs, ref.gameId, ref.presetId, releases);
  io.out(`catalog_holders=${releases.length}`);
}

async function dispatch(command: string | undefined, rest: readonly string[], env: NodeJS.ProcessEnv, deps: CliDeps, io: CliIo): Promise<void> {
  if (command === "write") await write(rest, env, deps, io);
  else if (command === "publish") await publish(rest, deps, io);
  else if (command === "hold-catalog") await holdCatalogCommand(rest, deps, io);
  else usage("command");
}

/** Runs one command; the exit code is 0, or 1 with a one-line `error=<code>` on stderr (2 for bad arguments). */
export async function runCommand(argv: readonly string[], env: NodeJS.ProcessEnv, make: (settings: CliSettings) => CliDeps, io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const bucket = env.RELEASE_BUCKET;
    if (bucket === undefined || bucket === "") usage("RELEASE_BUCKET");
    const deps = make({ bucket, table: env.RELEASE_REFS_TABLE });
    await dispatch(command, rest, env, deps, io);
    return 0;
  } catch (error) {
    const { code, bad } = classify(error);
    io.err(`release-writer ${command ?? ""}: ${error instanceof Error ? error.message : String(error)}`);
    io.err(`error=${code}`);
    return bad ? 2 : 1;
  }
}

function classify(error: unknown): Readonly<{ code: string; bad: boolean }> {
  if ((error instanceof WriterError && error.code === "invalid_arguments") || String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS")) return { code: "invalid_arguments", bad: true };
  if (error instanceof WriterError) return { code: error.code, bad: false };
  if (error instanceof ReleaseRefsError) return { code: error.message, bad: false };
  return { code: "internal_error", bad: false };
}
