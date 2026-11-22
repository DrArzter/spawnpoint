import { digestOfObjectKey, objectKey } from "./release-objects.ts";
import { buildingDigests, type ConsistencyReport, type Listing, type Marks, type TableView } from "./release-reconciler.ts";

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

export function planSweep(input: PlanInput): SweepPlan {
  const { report, marks, table, listing } = input;
  const cutoff = sweepCutoff(report.startedAt, input.graceDays);
  if (!report.complete || !report.sweepable || table === null || listing === null) return { reason: "incomplete_run", cutoff, actions: [] };

  const startedAt = Date.parse(report.startedAt);
  const cutoffTime = Date.parse(cutoff);
  const named = new Set<string>();
  for (const own of marks.digests.values()) for (const digest of own.keys()) named.add(digest);
  const unproven = (digest: string) => named.has(digest) || (table.backReferences.get(digest)?.size ?? 0) > 0;

  const finishing: SweepAction[] = [];
  const deleting: SweepAction[] = [];
  for (const [digest, item] of table.files) {
    if (item.state === "condemned") {
      const condemnedAt = time(item.condemnedAt);
      // `condemnedAt <= cutoff` also implies it is before the run's start; both are checked on purpose.
      if (item.refs === 0 && condemnedAt <= cutoffTime && condemnedAt < startedAt && !unproven(digest)) deleting.push({ kind: "delete", digest });
    } else if (item.state === "deleting") {
      const since = time(item.deletingAt);
      if (!Number.isNaN(since) && startedAt - since <= STUCK_AFTER_MS) continue; // another run may still work on it
      if (item.refs === 0 && !unproven(digest)) finishing.push({ kind: "finish", digest });
      else finishing.push({ kind: "revert", digest, to: item.refs > 0 ? "live" : "condemned" });
    }
  }

  // An object no manifest names, with no table item at all, and not a building release's upload.
  const building = buildingDigests(table);
  const orphans: SweepAction[] = [];
  for (const key of listing.keys) {
    const digest = digestOfObjectKey(key);
    if (digest === null || named.has(digest) || building.has(digest)) continue;
    if (table.files.has(digest) || table.backReferences.has(digest)) continue;
    orphans.push({ kind: "condemn", digest, bytes: listing.sizes?.get(key) ?? 0 });
  }

  const byDigest = (a: SweepAction, b: SweepAction) => a.digest.localeCompare(b.digest);
  return { reason: null, cutoff, actions: [...finishing.sort(byDigest), ...deleting.sort(byDigest), ...orphans.sort(byDigest)] };
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

export async function executeSweep(plan: SweepPlan, writer: SweepWriter, now: () => Date, log: SweepLog): Promise<SweepOutcome> {
  let swept = 0;
  let condemned = 0;
  let reverted = 0;
  let skipped = 0;
  const failures: SweepFailure[] = [];
  const fail = (digest: string, step: string, error: unknown) => {
    const failure = { digest, step, reason: typeof error === "string" ? error : reasonOf(error) };
    failures.push(failure);
    log({ event: "release_sweep_action", dryRun: false, result: "failed", ...failure });
  };
  const skip = (action: SweepAction, why: string) => {
    skipped += 1;
    log({ event: "release_sweep_action", dryRun: false, ...action, result: "skipped", why });
  };

  // Steps 2 and 3. Step 3 runs only when DeleteObject returned without an error.
  const removeAndMark = async (digest: string, kind: string) => {
    try {
      await writer.deleteObject(objectKey(digest));
    } catch (error) {
      fail(digest, "delete_object", error); // the item stays `deleting`
      return;
    }
    try {
      if (await writer.markDeleted(digest)) {
        swept += 1;
        log({ event: "release_sweep_action", dryRun: false, kind, digest, result: "deleted" });
      } else {
        fail(digest, "mark_deleted", "state_changed");
      }
    } catch (error) {
      fail(digest, "mark_deleted", error);
    }
  };

  for (const action of plan.actions) {
    try {
      if (action.kind === "delete") {
        if (await writer.markDeleting(action.digest, plan.cutoff, now().toISOString())) await removeAndMark(action.digest, "delete");
        else skip(action, "condition_lost");
      } else if (action.kind === "finish") {
        await removeAndMark(action.digest, "finish");
      } else if (action.kind === "revert") {
        if (await writer.revertDeleting(action.digest, action.to)) {
          reverted += 1;
          log({ event: "release_sweep_action", dryRun: false, ...action, result: "reverted" });
        } else {
          skip(action, "condition_lost");
        }
      } else if (await writer.condemnOrphan(action.digest, action.bytes, now().toISOString())) {
        condemned += 1;
        log({ event: "release_sweep_action", dryRun: false, ...action, result: "condemned" });
      } else {
        skip(action, "item_exists");
      }
    } catch (error) {
      fail(action.digest, action.kind, error);
    }
  }
  return { swept, condemned, reverted, skipped, failures };
}
