// The release diff (P3): what one release changes compared with another. The
// builder writes the same model as plan.json (server/scripts/plan-release.sh);
// both are held to the shared fixtures in server/tests/fixtures/release-plan.

export type PlanMod = Readonly<{ file: string; sha256: string; bytes: number; side?: string; mod_ids?: readonly string[] }>;
export type PlanOverride = Readonly<{ path: string; sha256: string; bytes: number }>;
export type PlanChange<T> = Readonly<{ from: T; to: T }>;
export type PlanClasses<T> = Readonly<{ added: readonly T[]; removed: readonly T[]; changed: readonly PlanChange<T>[]; unchanged: number }>;
export type PlanOverrideRoot = Readonly<{ root: string } & PlanClasses<PlanOverride>>;
export type PlanValue<T> = Readonly<{ from: T | null; to: T | null; changed: boolean }>;
export type PlanPack = Readonly<{ sha256: string; bytes: number }>;
export type PlanLoader = Readonly<{ type: string; version: string | null }>;

export type ReleasePlan = Readonly<{
  schema_version: 1;
  game: string;
  preset: string | null;
  release: string;
  previous_release: string | null;
  matched_by: "mod_id" | "file_name" | null;
  minecraft: PlanValue<string>;
  loader: PlanValue<PlanLoader>;
  runtime: PlanValue<string>;
  server_mods: PlanClasses<PlanMod>;
  server_overrides: Readonly<{ roots: readonly PlanOverrideRoot[] }>;
  client_mods: PlanClasses<PlanMod>;
  client_pack: PlanValue<PlanPack>;
}>;

type Manifest = Readonly<Record<string, unknown>>;
type ModIndex = Readonly<Record<string, readonly string[]>>;

function record(value: unknown): Manifest | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Manifest : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rawFiles(value: unknown): readonly Manifest[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
      const item = record(entry);
      return item && typeof item.file === "string" && typeof item.sha256 === "string" && typeof item.bytes === "number" ? [item] : [];
    })
    : [];
}

function modIndex(manifest: Manifest): ModIndex | null {
  const index = record(manifest.mod_index);
  if (index === null) return null;
  return Object.fromEntries(Object.entries(index).map(([digest, ids]) =>
    [digest, Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []]));
}

function entry(item: Manifest, index: ModIndex | null): PlanMod {
  const side = text(item.side);
  return {
    file: item.file as string,
    sha256: item.sha256 as string,
    bytes: item.bytes as number,
    ...(side ? { side } : {}),
    ...(index ? { mod_ids: index[item.sha256 as string] ?? [] } : {}),
  };
}

function client(manifest: Manifest): Manifest {
  return record(manifest.client) ?? {};
}

function serverMods(manifest: Manifest): readonly PlanMod[] {
  const index = modIndex(manifest);
  const sides = new Map(rawFiles(client(manifest).addons).map((addon) => [addon.file as string, text(addon.side)]));
  return rawFiles(record(manifest.server)?.mods).map((mod) => {
    const side = sides.get(mod.file as string);
    return entry(side ? { ...mod, side } : mod, index);
  });
}

// Files players get that the server does not run: the client-only part of a
// players set (ADR-0069) and client addons (ADR-0077).
function clientOnly(manifest: Manifest): readonly PlanMod[] {
  const index = modIndex(manifest);
  const server = new Set(rawFiles(record(manifest.server)?.mods).map((mod) => mod.file));
  const players = client(manifest);
  if (players.kind === "mod-set") return rawFiles(players.mods).filter((mod) => !server.has(mod.file)).map((mod) => entry(mod, index));
  return rawFiles(players.addons).filter((addon) => addon.side === "client").map((addon) => entry(addon, index));
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Pairing = Readonly<{ pairs: readonly (readonly [PlanMod, PlanMod])[]; olds: readonly PlanMod[]; news: readonly PlanMod[] }>;

function pair(olds: readonly PlanMod[], news: readonly PlanMod[], matches: (a: PlanMod, b: PlanMod) => boolean): Pairing {
  const pairs: (readonly [PlanMod, PlanMod])[] = [];
  const left: PlanMod[] = [];
  const remaining = [...news];
  for (const old of olds) {
    const index = remaining.findIndex((candidate) => matches(old, candidate));
    const [match] = index < 0 ? [] : remaining.splice(index, 1);
    if (match === undefined) left.push(old);
    else pairs.push([old, match]);
  }
  return { pairs, olds: left, news: remaining };
}

// Pairing order: the same name, then the same digest under another name, then
// a shared mod id when both manifests carry mod_index. The rest is removed or added.
function classes(old: readonly PlanMod[], next: readonly PlanMod[], byId: boolean): PlanClasses<PlanMod> {
  const byName = pair(old, next, (a, b) => a.file === b.file);
  const byDigest = pair(byName.olds, byName.news, (a, b) => a.sha256 === b.sha256);
  const byMod = byId
    ? pair(byDigest.olds, byDigest.news, (a, b) => (b.mod_ids ?? []).some((id) => (a.mod_ids ?? []).includes(id)))
    : { pairs: [], olds: byDigest.olds, news: byDigest.news };
  const sameName = byName.pairs.filter(([a, b]) => a.sha256 === b.sha256).length;
  return {
    added: [...byMod.news].sort((a, b) => byText(a.file, b.file)),
    removed: [...byMod.olds].sort((a, b) => byText(a.file, b.file)),
    changed: [...byName.pairs.filter(([a, b]) => a.sha256 !== b.sha256), ...byMod.pairs]
      .map(([from, to]) => ({ from, to }))
      .sort((a, b) => byText(a.to.file, b.to.file) || byText(a.from.file, b.from.file)),
    unchanged: sameName + byDigest.pairs.length,
  };
}

function overrides(manifest: Manifest): readonly PlanOverride[] {
  const list = record(manifest.server)?.overrides;
  return Array.isArray(list)
    ? list.flatMap((value) => {
      const item = record(value);
      return item && typeof item.path === "string" && typeof item.sha256 === "string" && typeof item.bytes === "number"
        ? [{ path: item.path, sha256: item.sha256, bytes: item.bytes }]
        : [];
    })
    : [];
}

function overrideRoots(old: readonly PlanOverride[], next: readonly PlanOverride[]): readonly PlanOverrideRoot[] {
  const rootOf = (item: PlanOverride) => item.path.split("/")[0] ?? "";
  const roots = [...new Set([...old, ...next].map(rootOf))].sort(byText);
  return roots.map((root) => {
    const o = old.filter((item) => rootOf(item) === root);
    const n = next.filter((item) => rootOf(item) === root);
    const byOld = new Map(o.map((item) => [item.path, item]));
    const byNew = new Map(n.map((item) => [item.path, item]));
    return {
      root,
      added: n.filter((item) => !byOld.has(item.path)),
      removed: o.filter((item) => !byNew.has(item.path)),
      changed: n.flatMap((item) => {
        const before = byOld.get(item.path);
        return before && before.sha256 !== item.sha256 ? [{ from: before, to: item }] : [];
      }),
      unchanged: n.filter((item) => byOld.get(item.path)?.sha256 === item.sha256).length,
    };
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = record(value);
  if (item) return `{${Object.keys(item).sort(byText).map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

function valueChange<T>(from: T | null, to: T | null, first: boolean): PlanValue<T> {
  return { from, to, changed: !first && canonical(from) !== canonical(to) };
}

function loader(manifest: Manifest): PlanLoader | null {
  const value = record(manifest.loader);
  return value ? value as unknown as PlanLoader : null;
}

function pack(manifest: Manifest): PlanPack | null {
  const players = client(manifest);
  return players.kind === "curseforge-modpack" ? { sha256: players.sha256 as string, bytes: players.bytes as number } : null;
}

function isManifest(value: Manifest | null): value is Manifest {
  return value !== null && value.schema_version === 1 && typeof value.release === "string" && Array.isArray(record(value.server)?.mods);
}

/** The plan of `next` against `previous`, or `null` when either is not a release manifest. `previous` null is a first release. */
export function releasePlan(nextValue: unknown, previousValue: unknown | null): ReleasePlan | null {
  const next = record(nextValue);
  const previous = previousValue === null ? null : record(previousValue);
  if (!isManifest(next) || (previousValue !== null && !isManifest(previous))) return null;
  const first = previous === null;
  const old: Manifest = previous ?? { server: { mods: [] } };
  const byId = modIndex(next) !== null && modIndex(old) !== null;
  return {
    schema_version: 1,
    game: text(next.game) ?? "minecraft",
    preset: text(record(next.source_profile)?.id),
    release: next.release as string,
    previous_release: first ? null : old.release as string,
    matched_by: first ? null : byId ? "mod_id" : "file_name",
    minecraft: valueChange(text(old.minecraft_version), text(next.minecraft_version), first),
    loader: valueChange(loader(old), loader(next), first),
    runtime: valueChange(text(record(old.runtime)?.image), text(record(next.runtime)?.image), first),
    server_mods: classes(serverMods(old), serverMods(next), byId),
    server_overrides: { roots: overrideRoots(overrides(old), overrides(next)) },
    client_mods: classes(clientOnly(old), clientOnly(next), byId),
    client_pack: valueChange(pack(old), pack(next), first),
  };
}

/** A stored plan.json, trusted only when it names the release it is stored under. */
export function storedReleasePlan(value: unknown, release: string): ReleasePlan | null {
  const plan = record(value);
  if (plan === null || plan.schema_version !== 1 || plan.release !== release) return null;
  if (plan.previous_release !== null && typeof plan.previous_release !== "string") return null;
  for (const key of ["server_mods", "client_mods"] as const) {
    const section = record(plan[key]);
    if (!section || !["added", "removed", "changed"].every((name) => Array.isArray(section[name])) || typeof section.unchanged !== "number") return null;
  }
  if (!Array.isArray(record(plan.server_overrides)?.roots)) return null;
  return plan as unknown as ReleasePlan;
}
