/** Releases are `major.minor` numbers; a larger number is a newer release. A name that is not one counts as older than any numbered release. */
export function compareReleases(left: string, right: string): number {
  const parts = (name: string) => name.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : Number.NaN);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) === Number.isNaN(y) ? left.localeCompare(right) : Number.isNaN(x) ? -1 : 1;
    if (x !== y) return x - y;
  }
  return 0;
}

/** The release rows of a list, newest first; both skins draw their downloads through it. */
export function newestFirst<Row extends Readonly<{ name: string }>>(rows: readonly Row[]): Row[] {
  return [...rows].sort((left, right) => compareReleases(right.name, left.name));
}
