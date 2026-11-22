import { holderKey, type HolderRole, type ReleaseRefs } from "./release-refs.ts";
import type { ReleaseState } from "./release-state.ts";
import type { WorldRecord } from "./world-registry.ts";

// Holder first (ADR-0080, design 4.8): a store adds the generation's holder to
// every release a record or pointer names before it writes that record or
// pointer, and stops when the holder cannot be written. No holder is removed
// here. Removal is retirement, which is later work.

/** What a pointer does not carry and the table needs to find the release item. */
export type WorldIdentity = Readonly<{ gameId: string; presetId: string }>;

/** Finds the game and preset of a world; it must throw when the world has no record (fail closed). */
export type ResolveWorld = (worldId: string) => Promise<WorldIdentity>;

type Holds = Pick<ReleaseRefs, "hold">;

export class ReleaseHolders {
  private readonly refs: Holds;
  private readonly resolve: ResolveWorld;

  constructor(refs: Holds, resolve: ResolveWorld) {
    this.refs = refs;
    this.resolve = resolve;
  }

  /** One generation's holder on one release, through `ReleaseRefs.hold`, which refuses a release that is not live even for a holder that exists. */
  async hold(identity: WorldIdentity, worldId: string, generationId: string, release: string, roles: readonly HolderRole[]): Promise<void> {
    const ref = { gameId: identity.gameId, presetId: identity.presetId, release };
    await this.refs.hold(ref, holderKey.generation(worldId, generationId), roles);
  }

  /** A record names the release its current generation started from. Earlier generations were held when they were current. */
  async holdRecord(record: WorldRecord): Promise<void> {
    const generation = record.currentGeneration;
    await this.hold({ gameId: record.gameId, presetId: record.preset.id }, record.worldId, generation.id, generation.release, ["origin"]);
  }

  /** A pointer names a release as desired, active, run or kept by a promotion. Pass `world` when the record is not stored yet. */
  async holdPointer(state: ReleaseState, world?: WorldIdentity): Promise<void> {
    const roles = new Map<string, Set<HolderRole>>();
    const add = (release: string | null | undefined, role: HolderRole) => {
      if (release === null || release === undefined) return;
      roles.set(release, (roles.get(release) ?? new Set<HolderRole>()).add(role));
    };
    add(state.desiredRelease, "desired");
    add(state.activeRelease, "active");
    for (const run of state.releasesRun ?? []) add(run.release, "run");
    add(state.prePromotionBackup?.release, "pre-promotion");
    const identity = world ?? await this.resolve(state.worldId);
    for (const [release, held] of roles) {
      await this.hold(identity, state.worldId, state.generationId, release, [...held]); // NOSONAR ordered: the first refusal stops the write
    }
  }
}

/** Resolves a world from its stored record. A world with no record is refused, so no pointer is written for it. */
export function resolveFromWorldRecords(worlds: Readonly<{ read: (worldId: string) => Promise<Readonly<{ record: WorldRecord }> | null> }>): ResolveWorld {
  return async (worldId) => {
    const stored = await worlds.read(worldId);
    if (stored === null) throw new Error("world_record_missing");
    return { gameId: stored.record.gameId, presetId: stored.record.preset.id };
  };
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RELEASE = /^\d+\.\d+$/;
// `legacy` stands for a pointer written before generations (worlds/<id>/release.json).
const GENERATION = /^(?:gen-[0-9a-f]{32}|legacy)$/;
export const HOLDER_ROLES: readonly HolderRole[] = ["origin", "desired", "active", "run", "pre-promotion"];

export type HoldRequest = Readonly<{ identity: WorldIdentity; worldId: string; generationId: string; release: string; roles: readonly HolderRole[] }>;

/** Arguments of the operator tool: game preset release world generation role[,role...]. A string is the reason for refusing them. */
export function parseHoldRequest(args: readonly string[]): HoldRequest | string {
  if (args.length !== 6) return "expected: game preset release world generation role[,role...]";
  const [gameId, presetId, release, worldId, generationId, roleList] = args as readonly [string, string, string, string, string, string];
  if (!NAME.test(gameId) || !NAME.test(presetId) || !NAME.test(worldId)) return "invalid game, preset or world";
  if (!RELEASE.test(release)) return "release must use MAJOR.MINOR";
  if (!GENERATION.test(generationId)) return "invalid generation";
  const roles = roleList.split(",");
  if (roles.some((role) => !(HOLDER_ROLES as readonly string[]).includes(role))) return `roles must be among: ${HOLDER_ROLES.join(", ")}`;
  return { identity: { gameId, presetId }, worldId, generationId, release, roles: roles as HolderRole[] };
}
