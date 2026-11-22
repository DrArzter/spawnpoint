import { useEffect } from "react";

const shown = new Map<string, number>();

/**
 * How many placeholder rows a list draws while it loads: the rows it already
 * knows (a fixed list), else as many as it showed the last time in this
 * session, else a few. A list that comes back (another world's backups) is then
 * as tall in its skeleton as in its content.
 */
export function useSkeletonRows(label: string, count: number, loading: boolean, fallback = 3): number {
  useEffect(() => {
    if (!loading) shown.set(label, count);
  }, [label, count, loading]);
  return Math.max(1, (count > 0 ? count : shown.get(label)) ?? fallback);
}
