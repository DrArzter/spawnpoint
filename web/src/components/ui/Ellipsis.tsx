import { cx } from "../../lib/cx";

// Cutting the end off an identifier hides the part that identifies it: two
// backups of one world differ only in their timestamp, and end-truncation
// renders both as the same string. So the tail is kept and the middle gives way.
//
// No measuring: the head is an ellipsised flex item that shrinks, the tail is a
// flex item that does not. The browser decides where the cut falls, at any
// width, with no layout reads and nothing to keep in sync.
export function Ellipsis({ value, tail = 14, className, mono = false }: Readonly<{
  value: string;
  /** Characters to keep, counted from the end. */
  tail?: number;
  className?: string;
  mono?: boolean;
}>) {
  const Tag = mono ? "code" : "span";
  if (value.length <= tail) return <Tag className={className} title={value}>{value}</Tag>;
  return (
    <Tag className={cx("ellipsis", className)} title={value}>
      <span className="ellipsis-head">{value.slice(0, -tail)}</span>
      <span className="ellipsis-tail">{value.slice(-tail)}</span>
    </Tag>
  );
}
