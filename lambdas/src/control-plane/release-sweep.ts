import { digestOfObjectKey, objectKey } from "./release-objects.ts";
import { buildingDigests, digestsNamed, type ConsistencyReport, type FileView, type Listing, type Marks, type TableView } from "./release-reconciler.ts";

// The sweep of ADR-0080 (design 4.8). `planSweep` is pure. `executeSweep` acts
// through a SweepWriter and never through a client, so the dry-run path can
// run without any write port.
//
// A file is deleted only when all of these hold:
//   1. refs = 0, state condemned, condemned_at at least the grace before the run started;
//   2. the digest is absent from the marks of a complete run that started after condemned_at;
//   3. the digest has no back-reference in the table.
// Missing references, extra references and counter drift stay report-only.

export const SWEEP_GRACE_DAYS_DEFAULT = 14;
const DAY_MS = 86_400_000;
/** A `deleting` item older than this belongs to a run that died. */
export const STUCK_AFTER_MS = 3_600_000;

/** Only the exact string "false" turns the dry run off; anything else keeps it on. */
export function sweepDryRun(value: string | undefined): boolean {
  return value !== "false";
}

/** Default 14 days, minimum 1. A value that is not a number is the default. */
export function sweepGraceDays(value: string | undefined): number {
  const days = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(days)) return SWEEP_GRACE_DAYS_DEFAULT;
  return Math.max(1, Math.floor(days));
}

export type SweepAction =
  /** Steps 1 to 3: a condemned file past its grace. */
  | Readonly<{ kind: "delete"; digest: string }>
  /** Steps 2 and 3: a `deleting` item that no one finished. */
  | Readonly<{ kind: "finish"; digest: string }>
  | Readonly<{ kind: "revert"; digest: string; to: "live" | "condemned" }>
  | Readonly<{ kind: "condemn"; digest: string; bytes: number }>;

export type SweepPlan = Readonly<{
  /** Set when the plan is empty because the run could not prove anything. */
  reason: "incomplete_run" | null;
  /** The newest `condemned_at` that may be deleted: the run's start minus the grace. */
  cutoff: string;
  actions: readonly SweepAction[];
}>;

export type PlanInput = Readonly<{
  report: ConsistencyReport;
  marks: Marks;
  table: TableView | null;
  listing: Listing;
  graceDays: number;
}>;

export function sweepCutoff(startedAt: string, graceDays: number): string {
  return new Date(Date.parse(startedAt) - graceDays * DAY_MS).toISOString();
}

function time(value: string | null): number {
  return value === null ? Number.NaN : Date.parse(value);
}

/** What the plan needs to judge one file: the run's times and the digests that are still named or referenced. */
type Judgement = Readonly<{ startedAt: number; cutoffTime: number; unproven: (digest: string) => boolean }>;

function judgeCondemned(digest: string, item: FileView, judge: Judgement): SweepAction | null {
  const condemnedAt = time(item.condemnedAt);
  // `condemnedAt <= cutoff` also implies it is before the run's start; both are checked on purpose.
  if (item.refs === 0 && condemnedAt <= judge.cutoffTime && condemnedAt < judge.startedAt && !judge.unproven(digest)) return { kind: "delete", digest };
  return null;
}

function judgeDeleting(digest: string, item: FileView, judge: Judgement): SweepAction | null {
  const since = time(item.deletingAt);
  if (!Number.isNaN(since) && judge.startedAt - since <= STUCK_AFTER_MS) return null; // another run may still work on it
  if (item.refs === 0 && !judge.unproven(digest)) return { kind: "finish", digest };
  return { kind: "revert", digest, to: item.refs > 0 ? "live" : "condemned" };
}

/** An object no manifest names, with no table item at all, and not a building release's upload. */
function orphanActions(listing: NonNullable<Listing>, table: TableView, named: ReadonlySet<string>): SweepAction[] {
  const building = buildingDigests(table);
  const orphans: SweepAction[] = [];
  for (const key of listing.keys) {
    const digest = digestOfObjectKey(key);
    if (digest === null || named.has(digest) || building.has(digest)) continue;
    if (table.files.has(digest) || table.backReferences.has(digest)) continue;
    orphans.push({ kind: "condemn", digest, bytes: listing.sizes?.get(key) ?? 0 });
  }
  return orphans;
}

const byDigest = (a: SweepAction, b: SweepAction) => a.digest.localeCompare(b.digest);

export function planSweep(input: PlanInput): SweepPlan {
  const { report, marks, table, listing } = input;
  const cutoff = sweepCutoff(report.startedAt, input.graceDays);
  if (!report.complete || !report.sweepable || table === null || listing === null) return { reason: "incomplete_run", cutoff, actions: [] };

  const named = digestsNamed(marks);
  const judge: Judgement = {
    startedAt: Date.parse(report.startedAt), cutoffTime: Date.parse(cutoff),
    unproven: (digest) => named.has(digest) || (table.backReferences.get(digest)?.size ?? 0) > 0,
  };

  const finishing: SweepAction[] = [];
  const deleting: SweepAction[] = [];
  for (const [digest, item] of table.files) {
    if (item.state === "condemned") {
      const action = judgeCondemned(digest, item, judge);
      if (action !== null) deleting.push(action);
    } else if (item.state === "deleting") {
      const action = judgeDeleting(digest, item, judge);
      if (action !== null) finishing.push(action);
    }
  }

  const orphans = orphanActions(listing, table, named);
  return { reason: null, cutoff, actions: [...finishing.toSorted(byDigest), ...deleting.toSorted(byDigest), ...orphans.toSorted(byDigest)] };
}

/** Each method is one conditional write or one delete; it returns false when its condition no longer held. */
export type SweepWriter = Readonly<{
  /** S3 DeleteObject of the current version. Never a version id. */
  deleteObject(key: string): Promise<void>;
  /** Step 1: state deleting, only while `refs = 0 AND state = condemned AND condemned_at <= cutoff`. */
  markDeleting(digest: string, cutoff: string, now: string): Promise<boolean>;
  /** Step 3: state deleted, only while `state = deleting`. */
  markDeleted(digest: string): Promise<boolean>;
  /** A stuck item goes back to `live` or `condemned`, only while `state = deleting`. */
  revertDeleting(digest: string, to: "live" | "condemned"): Promise<boolean>;
  /** A new condemned item for an orphan, only while the item does not exist. */
  condemnOrphan(digest: string, bytes: number, now: string): Promise<boolean>;
}>;

export type SweepFailure = Readonly<{ digest: string; step: string; reason: string }>;

export type SweepOutcome = Readonly<{
  swept: number;
  condemned: number;
  reverted: number;
  /** Actions whose condition no longer held: skipped, not an error. */
  skipped: number;
  failures: readonly SweepFailure[];
}>;

export type SweepLog = (line: Readonly<Record<string, unknown>>) => void;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/** Candidates are the files a real run would try to delete. */
export function sweepCandidates(plan: SweepPlan): number {
  return plan.actions.filter((action) => action.kind === "delete" || action.kind === "finish").length;
}

/** One log line per action, for a run that changes nothing. */
export function describeSweep(plan: SweepPlan): readonly Readonly<Record<string, unknown>>[] {
  return plan.actions.map((action) => ({ event: "release_sweep_action", dryRun: true, ...action }));
}

type Counters = { swept: number; condemned: number; reverted: number; skipped: number };

/** One run's writes. Each action is awaited before the next, and inside a delete the order deleting, DeleteObject, deleted is fixed. */
class SweepRun {
  readonly counts: Counters = { swept: 0, condemned: 0, reverted: 0, skipped: 0 };
  readonly failures: SweepFailure[] = [];
  private readonly plan: SweepPlan;
  private readonly writer: SweepWriter;
  private readonly now: () => Date;
  private readonly log: SweepLog;

  constructor(plan: SweepPlan, writer: SweepWriter, now: () => Date, log: SweepLog) {
    this.plan = plan;
    this.writer = writer;
    this.now = now;
    this.log = log;
  }

  async run(): Promise<SweepOutcome> {
    for (const action of this.plan.actions) {
      try {
        await this.act(action); // NOSONAR strictly sequential: deleting, then DeleteObject, then deleted
      } catch (error) {
        this.fail(action.digest, action.kind, error);
      }
    }
    return { ...this.counts, failures: this.failures };
  }

  private act(action: SweepAction): Promise<void> {
    switch (action.kind) {
      case "delete": return this.delete(action);
      case "finish": return this.removeAndMark(action.digest, "finish");
      case "revert": return this.revert(action);
      default: return this.condemn(action);
    }
  }

  private fail(digest: string, step: string, error: unknown): void {
    const failure = { digest, step, reason: typeof error === "string" ? error : reasonOf(error) };
    this.failures.push(failure);
    this.log({ event: "release_sweep_action", dryRun: false, result: "failed", ...failure });
  }

  private skip(action: SweepAction, why: string): void {
    this.counts.skipped += 1;
    this.log({ event: "release_sweep_action", dryRun: false, ...action, result: "skipped", why });
  }

  private async delete(action: Extract<SweepAction, { kind: "delete" }>): Promise<void> {
    if (await this.writer.markDeleting(action.digest, this.plan.cutoff, this.now().toISOString())) await this.removeAndMark(action.digest, "delete");
    else this.skip(action, "condition_lost");
  }

  private async revert(action: Extract<SweepAction, { kind: "revert" }>): Promise<void> {
    if (await this.writer.revertDeleting(action.digest, action.to)) {
      this.counts.reverted += 1;
      this.log({ event: "release_sweep_action", dryRun: false, ...action, result: "reverted" });
    } else {
      this.skip(action, "condition_lost");
    }
  }

  private async condemn(action: Extract<SweepAction, { kind: "condemn" }>): Promise<void> {
    if (await this.writer.condemnOrphan(action.digest, action.bytes, this.now().toISOString())) {
      this.counts.condemned += 1;
      this.log({ event: "release_sweep_action", dryRun: false, ...action, result: "condemned" });
    } else {
      this.skip(action, "item_exists");
    }
  }

  // Steps 2 and 3. Step 3 runs only when DeleteObject returned without an error.
  private async removeAndMark(digest: string, kind: string): Promise<void> {
    try {
      await this.writer.deleteObject(objectKey(digest));
    } catch (error) {
      this.fail(digest, "delete_object", error); // the item stays `deleting`
      return;
    }
    try {
      if (await this.writer.markDeleted(digest)) {
        this.counts.swept += 1;
        this.log({ event: "release_sweep_action", dryRun: false, kind, digest, result: "deleted" });
      } else {
        this.fail(digest, "mark_deleted", "state_changed");
      }
    } catch (error) {
      this.fail(digest, "mark_deleted", error);
    }
  }
}

export function executeSweep(plan: SweepPlan, writer: SweepWriter, now: () => Date, log: SweepLog): Promise<SweepOutcome> {
  return new SweepRun(plan, writer, now, log).run();
}
